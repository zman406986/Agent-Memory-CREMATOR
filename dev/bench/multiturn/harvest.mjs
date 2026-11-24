#!/usr/bin/env node
/**
 * Chunk 7 — Run A's harvested judge verdicts, joined to THIS lane's units
 * (design §3 stage B, §7 chunk 7, §8 "no keepall-by-construction").
 *
 * Usage:
 *   node dev/bench/multiturn/harvest.mjs [--answers <file>] [--db <snapshot>]
 *        [--corpus <corpus.json>] [--manifest <spike manifest.jsonl>]
 *        [--recorded <run-v4-tables.jsonl>] [--out <dir>] [--plan]
 *   node dev/bench/multiturn/harvest.mjs --fallback-plan [--db <snapshot>] [--corpus <corpus.json>]
 *
 *   --answers    Run A's `off-answers.json` (default: the 2026-10-24-035-live-ab
 *                lane file). One entry per asked table; a refused table carries
 *                a refusal record and no verdicts.
 *   --db         the chunk-0 snapshot, opened read-only. The lane's units are
 *                rebuilt from THIS file, never from a live store.
 *   --corpus     chunk 2's `corpus.json`: the 221-entry rule and the 39 matched
 *                sessions. A session absent from it is not a record of this lane.
 *   --manifest   the spike-008 v3 manifest the answers were keyed by. Default:
 *                the path Run A recorded (`corpus.manifest.path`); the recorded
 *                sha256 is verified before any join, so a swapped corpus is named.
 *   --recorded   gate 2's green OFF rows (`run-v4-tables.jsonl`), the only ask
 *                evidence an answer may be checked against (live-ab plan chunk 5).
 *                Absent prints as absent and the ask check is reported skipped.
 *   --out        where `verdicts.json` lands (default: the snapshot's directory).
 *   --plan       the design's verify form: analyse and print, write nothing.
 *   --fallback-plan
 *                print the bounded cost of the Q1 fallback harvest (chunk 8):
 *                tables, calls, prompt tokens, kill timer, token cap. No network.
 *
 * ## What is joined, and by which rule
 *
 * A spike unit id is `unit:sha256:<sha256(sessionId|turnIndex|resultIndex)>`
 * (spike-008 v3's own rule, `context-full.mjs:unitIdFor`). The manifest row for
 * that id names the session and the ordinal of the tool result. The ordinal is
 * over the session's tool results that the spike extractor kept — status
 * `completed` or `error`, non-empty rendered text — in `(message.sequence,
 * part.sequence, part.id)` order. Every answered row is checked against the
 * store: the part's raw output bytes and the line count of its normalized text
 * must equal the manifest row's `bytes`/`unitLines`. A disagreement names the
 * row (`spike-part-mismatch`); it is never silently matched.
 *
 * The lane unit is the part's own node, rendered exactly as `extract.mjs`
 * renders it (tool name + JSON input + output) and placed in its turn through
 * the message's `anchor.turnId`. The unit id is minted by chunk 5's own
 * catalogue (`removal.mjs` `snapshotNodes`, placeholder bodies), so the id this
 * module writes is the id chunks 5 and 6 will recognise: one catalogue, no
 * second id rule. A lane unit is one whole-result span (the shipped
 * `WholeResultSegmenter`), so its line form is one line — the same shape chunk 5
 * validates.
 *
 * ## The four outcomes of one verdict, named
 *
 *   unit                 the verdict names a unit this lane's planner can offer
 *   below-lane-bar       the rendered node is under the shipped unit bar (512 B,
 *                        so no unit exists for the planner to ask
 *   not-in-corpus        the session is not one of chunk 2's 221-entry sessions
 *   no-lane-turn         the part's message names no `turn_usage` turn, so the
 *                        node is in no turn of the lane's plan
 *   no-store-part        the manifest ordinal names no store part (the store moved)
 *   unresolved-spike-unit  the unit id is in no manifest row
 *   foreign-ranges       a `keeplines` verdict: its line ranges are spike-008
 *                        coordinates over the tool output, while the lane unit is
 *                        one line of rendered part bytes. The verdict joins its
 *                        unit and its action counts, but it contributes NO
 *                        decision: a partial removal this lane cannot place is
 *                        named, never translated by guesswork, and never rounded
 *                        up to a whole-unit removal.
 *
 * ## The frozen set (`decisions`)
 *
 * Only a whole-unit `forgetall` on a joined lane unit becomes a decision. Its
 * decision turn is the first lane boundary at which the shipped pass would ask
 * the unit (or prove it removable by L1), which is always after the unit's own
 * turn closes — the lane's protection rule, not the spike's. A unit no boundary
 * ever asks is `never-asked` and stays out of the set. The file is a chunk-5
 * `{decisions: [...]}` set with `source` naming Run A, so `removal.mjs` and
 * `score.mjs` consume it unchanged and a set minted in this process is still
 * refused (`set-not-frozen`).
 *
 * A decision carries its span in `ranges`, MATERIALIZED, because `ranges: []`
 * is the product's keepall shape: `appliedSetAt` ignores a keepall decision, so
 * a set whose decisions all look keepall scores as the empty set — the arms
 * come out byte-equal and the run measures the floor while reporting a removal
 * fraction. Emitting the lane unit's own line range is what makes the harvest
 * scoreable in one pass; the `wholeUnit` flag is omitted because `removal.mjs`
 * refuses `wholeUnit: true` beside a non-empty `ranges` and re-derives it from
 * the span itself.
 *
 * ## The compatibility verdict
 *
 * `compatible` requires all four: every non-refused table's `askSha256` equals
 * the gate-2 recorded row for the same `(sessionId, tableIndex)`; every
 * non-refused answer parses under the shipped `parsePruneAnswer` and its verdict
 * actions equal the entry's own `verdicts`; every answered session is in this
 * lane's corpus; every non-refused table has at least one verdict that joins a
 * lane unit. Otherwise `incompatible`, with each failing object named — and
 * chunk 8's owner-gated fallback is the design's remedy. An `incompatible` file
 * is not discarded: the units that DO join are still written, so the bracket has
 * its measured point; the verdict says the set cannot stand alone.
 *
 * ## The per-session census (chunk 8)
 *
 * The verdict above is one word for the whole file; chunk 8 needs the per-session
 * breakdown, because a judge verdict from spike-008's tool-output units does not
 * transfer 1:1 to this lane's whole-result units. `census` carries, per answered
 * session: its non-refused tables, verdicts, joined lane units, decisions, and
 * the count in each join-outcome class. A session is SCORED iff it is in the
 * filled corpus and at least one verdict names a lane unit; every other answered
 * session is CENSORED with a machine-readable class label (`fails-221-rule`,
 * `never-filled`, or the dominant miss: `below-lane-bar`, `no-lane-turn`,
 * `not-in-corpus`). Censored is not an error and not a silent drop — the class
 * counts are a first-class result, never a footnote.
 *
 * ## No network, no clock, no writes in --plan
 *
 * Nothing here imports a transport. `--plan` writes no file. The `--fallback-plan`
 * cost is ESTIMATED-BYTES: prefix bytes are read from the store's visible
 * messages at the record's `/4` quotient, and the ask size is the recorded set's
 * mean bytes per row (its source is printed beside it).
 *
 * Exit: 0 = report printed (or verdicts written) and no gate failed;
 *       1 = a gate failed, named on stderr (ask-mismatch, answer-parse,
 *           verdict-disagreement, spike-part-mismatch);
 *       2 = bad arguments, a missing input, an unreadable answers file, or a
 *           corpus whose digest is not the one the answers recorded.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_CONFIG, parsePruneAnswer, planPrunePass, splitLineOffsets, UnitTracker,
} from '@cremator/core';
import { boundarySnapshot, snapshotNodes } from './removal.mjs';
import { optionsOf, parseDevArgs } from '../../shared/args.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DEFAULT_ANSWERS = 'scratchpad/launch/2026-10-24-035-live-ab/lane/off-answers.json';
const DEFAULT_DB = 'scratchpad/bench/2026-10-24-multiturn/db-snapshot.sqlite';
const DEFAULT_RECORDED = 'scratchpad/spike-008/v4/out-tables-head-2026-10-24/run-v4-tables.jsonl';
const DEFAULT_FALLBACK_KILL_S = 1800;
const SCHEMA = 'racoons-multiturn-verdicts/1';
/** The run that harvested the answers; the set must never name this run. */
const SET_SOURCE = 'run A 2026-10-24 off-answers (harvested elsewhere)';
const BAR_BYTES = DEFAULT_CONFIG.protocol.barBytes;
/** The record's byte-to-token quotient (extract.mjs `byteQuotient`). */
const TOKEN_QUOTIENT = 4;
/** The spike extractor's normalized-text rule (`context-full.mjs`). */
const normLite = value => String(value ?? '')
  .replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();

function usage() {
  return 'usage: node dev/bench/multiturn/harvest.mjs [--answers <file>] [--db <snapshot>]'
    + ' [--corpus <corpus.json>] [--manifest <spike manifest.jsonl>]'
    + ' [--recorded <run-v4-tables.jsonl>] [--out <dir>] [--plan]'
    + '\n       node dev/bench/multiturn/harvest.mjs --fallback-plan [--db <snapshot>]'
    + ' [--corpus <corpus.json>]';
}

const HARVEST_OPTIONS = optionsOf([
  ['--answers', 'string'],
  ['--db', 'string'],
  ['--corpus', 'string'],
  ['--manifest', 'string'],
  ['--recorded', 'string'],
  ['--out', 'string'],
  ['--plan', 'boolean'],
  ['--fallback-plan', 'boolean'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: HARVEST_OPTIONS,
    usage,
    help: () => `${usage()}\n`,
  });
  return {
    answers: values.answers ?? DEFAULT_ANSWERS,
    db: values.db ?? DEFAULT_DB,
    corpus: values.corpus ?? null,
    manifest: values.manifest ?? null,
    recorded: values.recorded ?? DEFAULT_RECORDED,
    out: values.out ?? null,
    plan: values.plan ?? false,
    fallbackPlan: values.fallbackPlan ?? false,
  };
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const bytesOf = value => Buffer.byteLength(value ?? '', 'utf8');

/**
 * A path Run A recorded may be absolute on the other device. Resolve it only
 * when the bytes exist: absolute as recorded, then the repo-relative tail from
 * its own `scratchpad/` segment, then the caller's override.
 */
function resolveRecordedPath(recorded, override) {
  if (override !== null) return resolve(REPO_ROOT, override);
  if (typeof recorded !== 'string' || recorded.length === 0) return null;
  if (existsSync(recorded)) return recorded;
  const tail = recorded.replace(/\\/g, '/').lastIndexOf('scratchpad/');
  if (tail !== -1) {
    const candidate = join(REPO_ROOT, recorded.replace(/\\/g, '/').slice(tail));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The rendered byte length of one content part; the same quantity extract.mjs records. */
function renderPart(body) {
  if (body.type === 'text') return bytesOf(body.text);
  if (body.type === 'reasoning') return bytesOf(body.text ?? body.content);
  if (body.type === 'tool') {
    return bytesOf(body.tool)
      + bytesOf(JSON.stringify(body.state?.input ?? {}))
      + bytesOf(body.state?.output);
  }
  return 0;
}

const CONTENT_PART_TYPES = Object.freeze(['text', 'reasoning', 'tool']);

/**
 * One session's lane catalogue, built from the store exactly as `extract.mjs`
 * builds its turn plan: turns are `turn_usage` rows in `started_at` order, a
 * node's turn is its message's `anchor.turnId`, and structural parts are not
 * nodes. Nodes are then handed to chunk 5's `snapshotNodes`, so the unit ids are
 * chunk 5's own.
 */
function laneSession(db, sessionId) {
  const turnRows = db.prepare(
    `select turn_id, status from turn_usage where session_id = ? order by started_at, turn_id`,
  ).all(sessionId);
  const ordinalOf = new Map(turnRows.map((row, index) => [row.turn_id, index]));
  const requestTurns = new Set(db.prepare(
    'select distinct turn_id from model_usage where session_id = ? and turn_id is not null',
  ).all(sessionId).map(row => row.turn_id));

  const messages = db.prepare(
    'select id, sequence, data from message where session_id = ? order by sequence, time_created, id',
  ).all(sessionId).map(row => ({ ...row, body: JSON.parse(row.data) }));
  const messageById = new Map(messages.map(message => [message.id, message]));
  const parts = db.prepare(
    `select p.id, p.message_id, p.sequence, p.data, m.sequence as message_sequence
       from part p join message m on m.id = p.message_id
      where p.session_id = ? order by m.sequence, p.sequence, p.id`,
  ).all(sessionId).map(row => ({ ...row, body: JSON.parse(row.data) }));

  // The spike extractor's moment list: completed/error tool results with
  // non-empty rendered text, in (message, part) order. The manifest ordinal is
  // this list's index.
  const moments = [];
  for (const part of parts) {
    if (part.body.type !== 'tool') continue;
    const status = part.body.state?.status ?? 'unknown';
    if (status !== 'completed' && status !== 'error') continue;
    const raw = typeof part.body.state?.output === 'string' ? part.body.state.output
      : typeof part.body.state?.error === 'string' ? part.body.state.error : '';
    if (raw.length === 0) continue;
    moments.push({ part, raw });
  }

  const plan = turnRows.map((turn, ordinal) => ({ turnOrdinal: ordinal, turnId: turn.turn_id, nodes: [] }));
  const nodeByPartId = new Map();
  for (const part of parts) {
    if (!CONTENT_PART_TYPES.includes(part.body.type)) continue;
    const message = messageById.get(part.message_id);
    const turnId = message?.body.anchor?.turnId ?? null;
    const turnOrdinal = turnId !== null && ordinalOf.has(turnId) ? ordinalOf.get(turnId) : null;
    if (turnOrdinal === null) continue;
    const node = {
      id: part.id,
      kind: part.body.type,
      turnOrdinal,
      role: message?.body.role ?? null,
      origin: message?.body.semantics?.origin ?? null,
      providerVisible: message?.body.semantics?.providerVisibility !== 'hidden',
      bytes: renderPart(part.body),
      tool: part.body.type === 'tool' ? part.body.tool ?? null : null,
      callId: part.body.type === 'tool' ? part.body.callID ?? null : null,
      status: part.body.type === 'tool' ? part.body.state?.status ?? null : null,
      filePath: part.body.type === 'tool' ? part.body.state?.input?.file_path ?? null : null,
    };
    plan[turnOrdinal].nodes.push(node);
    nodeByPartId.set(part.id, node);
  }

  return {
    sessionId,
    turnRows,
    ordinalOf,
    requestTurns,
    plan,
    nodes: snapshotNodes(plan),
    nodeByPartId,
    moments,
    lastBoundary: turnRows.length === 0 ? -1
      : Math.max(...turnRows.map((turn, index) => (requestTurns.has(turn.turn_id) ? index : -1))),
  };
}

/** The shipped planner's answer at one boundary, composed exactly as chunk 5 does. */
function planBoundary(session, turnOrdinal, tracker) {
  const boundary = boundarySnapshot(session.nodes, turnOrdinal, session.sessionId);
  const units = tracker.units(boundary);
  const pass = planPrunePass({
    units, nodes: boundary.nodes.filter(node => node.kind === 'tool-result'),
    episodes: [], round: 0,
    // Every superseded-read dedupe class off — the shipped default (ADR-0037). The
    // pins this module reproduces were taken before the dedupe pass existed, so a
    // class turned on here would move them. `{}` is what the mount sends when no
    // operator names a class (`packages/adapters/dsh/src/prune.ts`).
    classes: {},
  });
  return {
    turnOrdinal,
    askable: new Set(pass.askRows.map(row => row.unit.id)),
    l1: new Set(pass.l1.removals.map(removal => removal.unitId)),
    askRows: pass.askRows.length,
  };
}

/**
 * The first boundary whose pass asks the unit (or proves it by L1). The unit's
 * own turn is still in flight at that turn's boundary, so the search starts
 * after it: a decision at T applies from T+1 (`appliedSetAt`), and a decision
 * over the boundary's own turn would be refused by chunk 5's `refused-in-flight`.
 */
function decisionTurnFor(session, unitId, nodeTurn, cache, tracker) {
  for (let turn = nodeTurn + 1; turn <= session.lastBoundary; turn++) {
    if (!cache.has(turn)) cache.set(turn, planBoundary(session, turn, tracker));
    const at = cache.get(turn);
    if (at.askable.has(unitId) || at.l1.has(unitId)) return turn;
  }
  return null;
}

function readAnswers(path) {
  if (!existsSync(path)) throw new Error(`answers-absent: ${path} does not exist`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`answers-unreadable: ${path}: ${error.message}`);
  }
  if (parsed?.kind !== 'off-answers' || !Array.isArray(parsed.answers)) {
    throw new Error(`answers-invalid: ${path} is not a Run A off-answers file`
      + ' (expected {kind: "off-answers", answers: [...]})');
  }
  const tables = new Map();
  const refused = [];
  for (const entry of parsed.answers) {
    if (typeof entry?.sessionId !== 'string' || !Number.isSafeInteger(entry?.tableIndex)) {
      throw new Error(`answers-invalid: ${path} carries an entry without sessionId/tableIndex`);
    }
    const key = `${entry.sessionId}#${entry.tableIndex}`;
    const isRefused = entry.mode === 'refused' || (entry.refused !== undefined && entry.refused !== null);
    if (isRefused) {
      if (entry.refused === undefined || entry.refused === null) {
        throw new Error(`answers-invalid: ${key} is marked refused but carries no refusal record`);
      }
      refused.push({
        tableId: entry.tableId ?? key,
        sessionId: entry.sessionId,
        tableIndex: entry.tableIndex,
        lastTurn: entry.lastTurn ?? null,
        tableUnits: entry.tableUnits ?? 0,
        code: entry.refused.code ?? null,
        detail: entry.refused.detail ?? null,
      });
      continue;
    }
    if (entry.answer === null || typeof entry.answer !== 'object' || Array.isArray(entry.answer)) {
      throw new Error(`answers-invalid: ${key} carries no answer object`);
    }
    tables.set(key, entry);
  }
  return { document: parsed, path, tables, refused };
}

function readRecordedSet(path) {
  if (!existsSync(path)) return { path, present: false, rows: 0, map: new Map() };
  const map = new Map();
  let rows = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`recorded-unreadable: ${path}: ${error.message}`);
    }
    if (row.arm !== 'off') continue;
    rows += 1;
    map.set(`${row.sessionId}#${row.tableIndex}`, {
      askSha256: row.askSha256 ?? null,
      askBytes: Number.isSafeInteger(row.askBytes) ? row.askBytes : null,
      tableUnits: Number.isSafeInteger(row.tableUnits) ? row.tableUnits : null,
      promptBytes: Number.isSafeInteger(row.promptBytes) ? row.promptBytes : null,
      promptTokens: Number.isSafeInteger(row.promptTokens) ? row.promptTokens : null,
      verdicts: Array.isArray(row.verdicts) ? row.verdicts : [],
    });
  }
  return { path, present: true, rows, map };
}

function readCorpus(path) {
  if (!existsSync(path)) throw new Error(`corpus-absent: ${path} does not exist (run select.mjs first)`);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed?.sessions)) {
    throw new Error(`corpus-invalid: ${path} carries no sessions array`);
  }
  const rows = new Map(parsed.sessions.map(row => [row.id, row]));
  return {
    path,
    document: parsed,
    rows,
    matched: new Set(Array.isArray(parsed.matched) ? parsed.matched : []),
    filled: new Set(parsed.sessions.filter(row => row.fills > 0).map(row => row.id)),
  };
}

function readManifest(path, answersDocument) {
  if (existsSync(path) === false) {
    throw new Error(`manifest-absent: ${path} does not exist (pass --manifest)`);
  }
  const expected = answersDocument.corpus?.manifest?.sha256 ?? null;
  const observed = sha256(readFileSync(path));
  if (expected !== null && observed !== expected) {
    throw new Error(`corpus-digest-mismatch: ${path} is ${observed}, the answers recorded ${expected};`
      + ' every unit id would be an unproven join');
  }
  const byUnit = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line);
    if (typeof row.id !== 'string' || typeof row.unitId !== 'string') {
      throw new Error(`manifest-invalid: ${path} carries a row without id/unitId`);
    }
    const derived = `unit:sha256:${sha256(row.id)}`;
    if (derived !== row.unitId) {
      throw new Error(`manifest-invalid: row ${row.id} carries ${row.unitId} but hashes to ${derived}`);
    }
    byUnit.set(row.unitId, row);
  }
  return { path, observed, expected, verified: expected !== null && observed === expected, byUnit };
}

/**
 * One answer entry sat by the shipped parser: one row per assigned index,
 * actions compared against the entry's own verdict list. A disagreement is a
 * gate: the file says one thing and its own answer object says another.
 */
function parseTable(entry) {
  const verdicts = Array.isArray(entry.verdicts) ? entry.verdicts : [];
  const indices = verdicts.map(verdict => verdict.index).sort((a, b) => a - b);
  const stamps = new Map(verdicts.map(verdict => [verdict.index, {
    unitId: verdict.unitId, answeredInRound: 0,
  }]));
  const parsed = parsePruneAnswer(entry.answer, { indices, stamps });
  const actionOf = new Map();
  for (const row of parsed.rows) {
    if (row.status === 'answered') actionOf.set(row.index, row.answer.verdict.action);
  }
  const disagreements = [];
  for (const verdict of verdicts) {
    const parsedAction = actionOf.get(verdict.index);
    if (parsedAction === undefined) {
      disagreements.push({ index: verdict.index, recorded: verdict.action, parsed: 'refused' });
    } else if (parsedAction !== verdict.action) {
      disagreements.push({ index: verdict.index, recorded: verdict.action, parsed: parsedAction });
    }
  }
  return {
    answered: parsed.rows.filter(row => row.status === 'answered').length,
    refusedRows: parsed.rows.filter(row => row.status === 'refused').length,
    rejected: parsed.rejected.length,
    disagreements,
  };
}

/**
 * The per-session compatibility census (chunk 8): for every answered session,
 * which outcome classes its verdicts land in, and whether the session is one
 * this lane can score at all. Classes are the join outcomes `laneSession` mints,
 * so the census and the join cannot disagree about a verdict's fate; the
 * scoring-side class `no-filled-record` is added here because only a session
 * with an observed fill has a fill to defer.
 *
 * A censored session is NOT an error and NOT a silent drop: it is excluded from
 * the median and carried with its class labels, so the paper can say how much of
 * the judge set was usable on this lane's units.
 */
function sessionCensus({ tables, corpus, decisions }) {
  const bySession = new Map();
  for (const table of tables) {
    const row = bySession.get(table.sessionId) ?? {
      sessionId: table.sessionId, tables: 0, verdicts: 0, joined: 0, decisions: 0,
      inCorpus: table.inCorpus, inFilledCorpus: corpus.filled.has(table.sessionId),
      classes: {},
    };
    row.tables += 1;
    for (const verdict of table.verdicts) {
      row.verdicts += 1;
      const label = verdict.join ?? 'unknown';
      row.classes[label] = (row.classes[label] ?? 0) + 1;
      if (verdict.join === 'unit' || verdict.join === 'foreign-ranges') row.joined += 1;
    }
    row.inCorpus = row.inCorpus && table.inCorpus;
    bySession.set(table.sessionId, row);
  }
  for (const decision of decisions) {
    const sessionId = decisionSessionOf(decision);
    const row = bySession.get(sessionId);
    if (row !== undefined) row.decisions += 1;
  }
  const rows = [...bySession.values()].map(row => {
    // The censoring classes, at session granularity. A session is scored on this
    // lane iff it is in the filled corpus AND at least one verdict names a lane
    // unit. Everything else is named, never silently dropped.
    const censoring = [];
    if (!row.inCorpus) censoring.push('fails-221-rule');
    if (row.inCorpus && !row.inFilledCorpus) censoring.push('never-filled');
    const unitClasses = Object.entries(row.classes)
      .filter(([label, count]) => label !== 'unit' && label !== 'foreign-ranges' && count > 0)
      .map(([label]) => label);
    if (row.joined === 0 && row.inCorpus) {
      // Every verdict missed a lane unit; the dominant miss names the class.
      const deepest = unitClasses
        .map(label => [label, row.classes[label]])
        .sort((a, b) => b[1] - a[1])[0];
      if (deepest !== undefined) censoring.push(deepest[0]);
    }
    // A joined unit is not a measured point: a `keeplines` verdict names spike-008
    // line coordinates and contributes NO whole-unit decision, so a session whose
    // only joins are foreign-ranges carries the empty set into the lane and its
    // ratio equals the floor by construction. Named, never scored as a result.
    if (row.inCorpus && row.joined > 0 && row.decisions === 0) {
      censoring.push('no-whole-unit-verdict');
    }
    return {
      ...row,
      censoring,
      scored: censoring.length === 0,
    };
  }).sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));

  const classCounts = {};
  for (const row of rows) {
    for (const [label, count] of Object.entries(row.classes)) {
      classCounts[label] = (classCounts[label] ?? 0) + count;
    }
  }
  const censoredByClass = {};
  for (const row of rows) {
    for (const label of row.censoring) {
      censoredByClass[label] = (censoredByClass[label] ?? 0) + 1;
    }
  }
  return {
    sessions: rows.length,
    scored: rows.filter(row => row.scored).length,
    censored: rows.filter(row => !row.scored).length,
    scoredSessions: rows.filter(row => row.scored).map(row => row.sessionId),
    classCounts,
    censoredByClass,
    rule: 'a session is scored on this lane iff it is in the filled corpus and it carries at'
      + ' least one whole-unit decision; every other answered session is censored with a class'
      + ' label and excluded from the median, never treated as an error and never silently'
      + ' dropped. Classes STACK (a session can be both never-filled and no-whole-unit-verdict),'
      + ' so the per-class counts sum to more than the censored total',
    rows,
  };
}

/**
 * The session a decision came from. A harvested decision's label is
 * `harvested <sessionId>#t<index> #<verdictIndex>`, minted by this module; a
 * label in any other shape names no session and is counted by the caller's
 * missing-session guard rather than guessed at.
 */
function decisionSessionOf(decision) {
  const label = typeof decision.label === 'string' ? decision.label : '';
  const harvested = label.match(/^harvested\s+(.+?)#t\d+(?:\s|$)/u);
  return harvested === null ? null : harvested[1];
}

function harvest(opts) {
  const answersPath = resolve(REPO_ROOT, opts.answers);
  const answers = readAnswers(answersPath);
  const dbPath = resolve(REPO_ROOT, opts.db);
  if (!existsSync(dbPath)) throw new Error(`snapshot-absent: ${dbPath} does not exist`);
  const corpusPath = opts.corpus === null
    ? join(dbPath, '..', 'corpus.json') : resolve(REPO_ROOT, opts.corpus);
  const corpus = readCorpus(corpusPath);

  const recordedManifest = answers.document.corpus?.manifest?.path ?? null;
  const manifestPath = resolveRecordedPath(recordedManifest, opts.manifest);
  if (manifestPath === null) {
    throw new Error('manifest-absent: the answers record a manifest this device does not have'
      + ` (${recordedManifest ?? 'none'}); pass --manifest`);
  }
  const manifest = readManifest(manifestPath, answers.document);
  const recorded = readRecordedSet(resolve(REPO_ROOT, opts.recorded));

  const failures = [];
  const fail = (code, message) => failures.push({ code, message });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const sessions = new Map();
  const sessionOf = id => {
    if (!sessions.has(id)) sessions.set(id, laneSession(db, id));
    return sessions.get(id);
  };

  const counts = {
    tables: answers.tables.size,
    refusedTables: answers.refused.length,
    verdicts: 0,
    joined: 0,
    forgetall: 0,
    keepall: 0,
    keeplines: 0,
    belowLaneBar: 0,
    notInCorpus: 0,
    noLaneTurn: 0,
    noStorePart: 0,
    unresolvedSpikeUnit: 0,
    duplicateLaneUnit: 0,
    foreignRanges: 0,
    neverAsked: 0,
    decisions: 0,
    /** Verdicts that resolved to a spike decision moment (a manifest row + a store part). */
    moments: 0,
  };
  const reasons = new Map();
  const note = (code, detail) => {
    counts[REASON_FIELD[code]] = (counts[REASON_FIELD[code]] ?? 0) + 1;
    const list = reasons.get(code) ?? [];
    list.push(detail);
    reasons.set(code, list);
  };

  const ask = { recorded, matched: 0, mismatched: [], absent: [] };
  const tables = [];
  const units = [];
  const decisions = [];
  const laneUnitIds = new Map();
  const sessionInCorpus = new Map();
  const boundaryCacheBySession = new Map();
  const trackerOf = new Map();
  let askBytesTotal = 0;
  let promptBytesTotal = 0;
  let promptTokensTotal = 0;
  let livePromptTokens = 0;

  const ordered = [...answers.tables.entries()]
    .map(([key, entry]) => ({ key, entry }))
    .sort((a, b) => (a.entry.sessionId < b.entry.sessionId ? -1
      : a.entry.sessionId > b.entry.sessionId ? 1 : a.entry.tableIndex - b.entry.tableIndex));

  for (const { key, entry } of ordered) {
    const parsed = parseTable(entry);
    if (parsed.disagreements.length > 0) {
      fail('verdict-disagreement', `${key}: the answer object and the entry's verdicts disagree at`
        + ` index ${parsed.disagreements.map(row => `${row.index} (${row.recorded} vs ${row.parsed})`)
          .join(', ')}`);
    }
    if (parsed.refusedRows > 0 || parsed.rejected > 0) {
      fail('answer-parse', `${key}: the shipped parser refused ${parsed.refusedRows} row(s) and`
        + ` rejected ${parsed.rejected} key(s)`);
    }

    const rec = recorded.map.get(key);
    if (!recorded.present) {
      // Reported once below; nothing to compare against.
    } else if (rec === undefined) {
      ask.absent.push(key);
      fail('ask-mismatch', `${key}: the gate-2 recorded set has no OFF row for this table`);
    } else if (rec.askSha256 !== entry.askSha256) {
      ask.mismatched.push(key);
      fail('ask-mismatch', `${key}: the answer was recorded for ask ${entry.askSha256},`
        + ` the gate-2 row carries ${rec.askSha256}`);
    } else {
      ask.matched += 1;
    }
    if (rec !== undefined) {
      askBytesTotal += rec.askBytes ?? 0;
      promptBytesTotal += rec.promptBytes ?? 0;
      promptTokensTotal += rec.promptTokens ?? 0;
    }
    if (Number.isSafeInteger(entry.live?.usage?.prompt_tokens)) {
      livePromptTokens += entry.live.usage.prompt_tokens;
    }

    const inCorpus = sessionInCorpus.get(entry.sessionId) ?? corpus.rows.has(entry.sessionId);
    sessionInCorpus.set(entry.sessionId, inCorpus);
    const session = inCorpus ? sessionOf(entry.sessionId) : null;
    if (session !== null && !trackerOf.has(entry.sessionId)) {
      trackerOf.set(entry.sessionId, new UnitTracker({ sessionId: entry.sessionId, barBytes: BAR_BYTES }));
    }
    if (session !== null && !boundaryCacheBySession.has(entry.sessionId)) {
      boundaryCacheBySession.set(entry.sessionId, new Map());
    }

    const verdictRows = [];
    for (const verdict of Array.isArray(entry.verdicts) ? entry.verdicts : []) {
      counts.verdicts += 1;
      counts[verdict.action] = (counts[verdict.action] ?? 0) + 1;
      const row = {
        index: verdict.index,
        spikeUnitId: verdict.unitId,
        action: verdict.action,
        summary: null,
        keptRanges: null,
        removedRanges: null,
        unit: null,
        join: null,
      };
      const manifestRow = manifest.byUnit.get(verdict.unitId);
      if (manifestRow === undefined) {
        row.join = 'unresolved-spike-unit';
        note('unresolved-spike-unit', { tableId: entry.tableId ?? key, index: verdict.index,
          spikeUnitId: verdict.unitId });
        verdictRows.push(row);
        continue;
      }
      if (!inCorpus) {
        row.join = 'not-in-corpus';
        note('not-in-corpus', { sessionId: entry.sessionId, tableId: entry.tableId ?? key,
          index: verdict.index });
        verdictRows.push(row);
        continue;
      }
      const [spikeSession, , resultIndexText] = manifestRow.id.split('|');
      const moment = session.moments[Number(resultIndexText)];
      if (spikeSession !== entry.sessionId || moment === undefined) {
        row.join = 'no-store-part';
        note('no-store-part', { tableId: entry.tableId ?? key, index: verdict.index,
          manifestId: manifestRow.id, moments: session.moments.length });
        verdictRows.push(row);
        continue;
      }
      const rawBytes = bytesOf(moment.raw);
      const rawLines = normLite(moment.raw).split('\n').length;
      if (rawBytes !== manifestRow.bytes || rawLines !== manifestRow.unitLines) {
        row.join = 'spike-part-mismatch';
        fail('spike-part-mismatch', `${manifestRow.id}: the store part is ${rawBytes} B /`
          + ` ${rawLines} line(s), the manifest row records ${manifestRow.bytes} B /`
          + ` ${manifestRow.unitLines}`);
        verdictRows.push(row);
        continue;
      }
      counts.moments += 1;
      const node = session.nodeByPartId.get(moment.part.id);
      if (node === undefined) {
        row.join = 'no-lane-turn';
        note('no-lane-turn', { tableId: entry.tableId ?? key, index: verdict.index,
          partId: moment.part.id });
        verdictRows.push(row);
        continue;
      }
      if (node.bytes < BAR_BYTES) {
        row.join = 'below-lane-bar';
        note('below-lane-bar', { tableId: entry.tableId ?? key, index: verdict.index,
          partId: moment.part.id, bytes: node.bytes, barBytes: BAR_BYTES });
        verdictRows.push(row);
        continue;
      }
      const laneNode = session.nodes.find(candidate => candidate.id === node.id);
      const tracker = trackerOf.get(entry.sessionId);
      // The unit catalogue at the last boundary that still holds the node: the
      // planner only ever sees nodes of turns at or before the boundary.
      const boundary = boundarySnapshot(
        session.nodes, Math.max(session.lastBoundary, node.turnOrdinal), entry.sessionId,
      );
      const laneUnit = tracker.units(boundary).find(candidate => candidate.nodeId === node.id);
      if (laneNode === undefined || laneUnit === undefined) {
        row.join = 'never-asked';
        note('never-asked', { tableId: entry.tableId ?? key, index: verdict.index,
          partId: moment.part.id });
        verdictRows.push(row);
        continue;
      }
      const existing = laneUnitIds.get(laneUnit.id);
      if (existing !== undefined && existing !== verdict.unitId) {
        row.join = 'duplicate-lane-unit';
        note('duplicate-lane-unit', { laneUnitId: laneUnit.id, spikeUnitIds: [existing, verdict.unitId] });
        verdictRows.push(row);
        continue;
      }
      laneUnitIds.set(laneUnit.id, verdict.unitId);
      const lineCount = splitLineOffsets(laneNode.bytes).length;
      row.unit = {
        laneUnitId: laneUnit.id,
        spikeUnitId: verdict.unitId,
        nodeId: laneNode.id,
        turnOrdinal: node.turnOrdinal,
        byteLength: laneNode.bytes.length,
        lineCount,
        path: node.filePath,
      };
      units.push({ ...row.unit, action: verdict.action, tableId: entry.tableId ?? key });
      // A keeplines verdict's ranges are spike-008 line coordinates over the tool
      // output; the lane unit is one line of rendered part bytes. It joins and its
      // action counts, but it names no whole-unit removal, so it contributes no
      // decision. Named, never rounded up to `forgetall`.
      if (verdict.action === 'keeplines') {
        const recordedRow = recordedRowFor(recorded, key, verdict.index);
        row.keptRanges = recordedRow?.keptRanges ?? null;
        row.removedRanges = recordedRow?.removedRanges ?? null;
        row.join = 'foreign-ranges';
        counts.joined += 1;
        note('foreign-ranges', { tableId: entry.tableId ?? key, index: verdict.index,
          laneUnitId: laneUnit.id });
        verdictRows.push(row);
        continue;
      }
      row.join = 'unit';
      counts.joined += 1;
      const decisionTurn = decisionTurnFor(
        session, laneUnit.id, node.turnOrdinal,
        boundaryCacheBySession.get(entry.sessionId), tracker,
      );
      if (verdict.action === 'forgetall' && decisionTurn !== null) {
        row.unit.decisionTurn = decisionTurn;
        decisions.push({
          turn: decisionTurn,
          unitId: laneUnit.id,
          // The unit's whole span, MATERIALIZED — and no `wholeUnit` flag, so the
          // decision is exactly chunk 5's accepted shape. `ranges: []` is the
          // product's keepall shape (`appliedSetAt` ignores such a decision
          // entirely), so a set carrying it scores as the empty set: the arms
          // come out byte-equal and the run measures the floor, not a removal.
          // Whole-unit-ness is carried by the range spanning the unit's own line
          // form, which is also how `removal.mjs` re-derives `wholeUnit`; a
          // `wholeUnit: true` beside a non-empty `ranges` is refused as
          // exclusive by that module, so the two shapes cannot be mixed.
          ranges: laneUnit.span.lineRange === null ? [] : [{
            startLine: laneUnit.span.lineRange.startLine,
            endLineInclusive: laneUnit.span.lineRange.endLineInclusive,
          }],
          // The session this decision belongs to. A lane unit id is minted per
          // session, so a set carrying several sessions MUST be scoped by this
          // field: `score.mjs` applies a set per record and a decision taken on
          // one session's turn ordinal would otherwise be deducted from every
          // other session's depth at that same ordinal.
          sessionId: entry.sessionId,
          label: `harvested ${entry.tableId ?? key} #${verdict.index}`,
          path: node.filePath,
          byteLength: laneNode.bytes.length,
        });
        counts.decisions += 1;
      } else if (verdict.action === 'forgetall') {
        row.unit.decisionTurn = null;
        note('never-asked', { tableId: entry.tableId ?? key, index: verdict.index,
          laneUnitId: laneUnit.id });
      }
      verdictRows.push(row);
    }

    tables.push({
      tableId: entry.tableId ?? key,
      sessionId: entry.sessionId,
      tableIndex: entry.tableIndex,
      lastTurn: entry.lastTurn ?? null,
      tableUnits: entry.tableUnits ?? null,
      mode: entry.mode ?? null,
      askSha256: entry.askSha256 ?? null,
      answerSha256: entry.answerSha256 ?? null,
      livePromptTokens: Number.isSafeInteger(entry.live?.usage?.prompt_tokens)
        ? entry.live.usage.prompt_tokens : null,
      inCorpus,
      recorded: rec ?? null,
      parse: {
        answered: parsed.answered, refusedRows: parsed.refusedRows, rejected: parsed.rejected,
      },
      verdicts: verdictRows,
    });
  }

  // The compatibility verdict: corpus, unit coverage, ask fidelity, parser.
  const compatibilityReasons = [];
  if (recorded.present && ask.mismatched.length + ask.absent.length > 0) {
    compatibilityReasons.push(`ask: ${ask.mismatched.length} mismatch(es),`
      + ` ${ask.absent.length} absent from the gate-2 set`);
  }
  if (!recorded.present) {
    compatibilityReasons.push(`ask: the gate-2 recorded set is absent (${recorded.path}),`
      + ' so ask fidelity cannot be checked');
  }
  const answeredSessions = [...sessionInCorpus.entries()];
  const outside = answeredSessions.filter(([, inside]) => !inside).map(([id]) => id);
  if (outside.length > 0) {
    compatibilityReasons.push(`corpus: ${outside.length}/${answeredSessions.length} answered`
      + ` session(s) are not in this lane's 221-entry corpus (${outside.join(', ')})`);
  }
  const emptyTables = tables.filter(table => !table.verdicts.some(row => row.join === 'unit'
    || row.join === 'foreign-ranges'));
  if (emptyTables.length > 0) {
    compatibilityReasons.push(`units: ${emptyTables.length}/${tables.length} non-refused table(s)`
      + ` name no unit this lane's planner can offer (${emptyTables.map(row => row.tableId).join(', ')})`);
  }
  if (failures.length > 0) {
    compatibilityReasons.push(`gates: ${failures.map(failure => failure.code).join(', ')}`);
  }
  const compatible = compatibilityReasons.length === 0;
  const census = sessionCensus({ tables, corpus, decisions });

  const output = {
    schema: SCHEMA,
    // The chunk-5/6 set readers take `source` as the provenance WORD (a set that
    // says "this-run" is refused). The measured details ride under `provenance`.
    source: SET_SOURCE,
    provenance: {
      path: answersPath,
      sha256: sha256(readFileSync(answersPath)),
      tool: answers.document.tool ?? null,
      kind: answers.document.kind,
      version: answers.document.version ?? null,
      label: answers.document.label ?? null,
      mode: answers.document.mode ?? null,
      model: answers.document.model ?? null,
      rowsSha256: answers.document.rowsSha256 ?? null,
      tables: answers.document.tables ?? null,
      killTimer: answers.document.killTimer ?? null,
      selection: answers.document.selection ?? null,
      corpus: {
        manifest: {
          path: manifestPath,
          recordedPath: recordedManifest,
          sha256: manifest.observed,
          recordedSha256: manifest.expected,
          verified: manifest.verified,
        },
        conversation: answers.document.corpus?.conversation ?? null,
      },
    },
    lane: {
      snapshot: { path: dbPath },
      corpus: { path: corpus.path, counts: corpus.document.counts ?? null,
        matched: corpus.document.matched?.length ?? null },
      barBytes: BAR_BYTES,
      byteQuotient: TOKEN_QUOTIENT,
      idRule: 'chunk 5 snapshotNodes placeholder bodies; one whole-result span per node',
    },
    ask: {
      recorded: { path: recorded.path, present: recorded.present, rows: recorded.rows },
      matched: ask.matched,
      mismatched: ask.mismatched,
      absent: ask.absent,
      askBytes: askBytesTotal,
      promptBytes: promptBytesTotal,
      promptTokens: promptTokensTotal,
      livePromptTokens,
    },
    compatibility: {
      verdict: compatible ? 'compatible' : 'incompatible',
      reasons: compatibilityReasons,
      notes: [
        'keeplines verdicts join their lane unit and count toward `joined`, but carry spike-008'
        + ' line coordinates over tool output, so they contribute NO decision (named, never'
        + ' rounded up to a whole-unit removal)',
        'a verdict whose unit is below the lane bar, outside the corpus or in no lane turn is'
        + ' named by outcome and contributes nothing to the frozen set',
      ],
      rule: 'compatible iff the ask hashes match the gate-2 rows, the shipped parser agrees,'
        + ' every answered session is in the lane corpus, and every non-refused table joins'
        + ' at least one lane unit; keeplines verdicts are a per-verdict note, not a reason',
    },
    refused: answers.refused,
    tables,
    units,
    decisions,
    census,
    counts: {
      ...counts,
      answeredSessions: answeredSessions.length,
      sessionsOutsideCorpus: outside.length,
      tablesWithoutLaneUnit: emptyTables.length,
    },
    reasons: Object.fromEntries([...reasons.entries()].map(([code, list]) => [code, list.slice(0, 20)])),
  };
  db.close();
  return { output, failures, compatible };
}

/** A recorded row's verdict facts, when the recorded set carries verdicts. */
function recordedRowFor(recorded, key, index) {
  if (!recorded.present) return null;
  const row = recorded.map.get(key);
  if (row === undefined) return null;
  const verdict = (row.verdicts ?? []).find(entry => entry.index === index);
  return verdict ?? null;
}

/** Outcome code → the counts field it increments. */
const REASON_FIELD = Object.freeze({
  'unresolved-spike-unit': 'unresolvedSpikeUnit',
  'not-in-corpus': 'notInCorpus',
  'no-store-part': 'noStorePart',
  'no-lane-turn': 'noLaneTurn',
  'below-lane-bar': 'belowLaneBar',
  'duplicate-lane-unit': 'duplicateLaneUnit',
  'foreign-ranges': 'foreignRanges',
  'never-asked': 'neverAsked',
});

/**
 * The Q1 fallback's bounded cost (chunk 8): how many tables, calls, prompt
 * tokens and which ceilings. Prefix bytes come from the store's visible messages
 * at the record's quotient; the ask size is the recorded set's mean bytes per
 * row, printed with its source. Nothing is sent and nothing is written.
 */
function fallbackPlan(opts) {
  const dbPath = resolve(REPO_ROOT, opts.db);
  if (!existsSync(dbPath)) throw new Error(`snapshot-absent: ${dbPath} does not exist`);
  const corpusPath = opts.corpus === null
    ? join(dbPath, '..', 'corpus.json') : resolve(REPO_ROOT, opts.corpus);
  const corpus = readCorpus(corpusPath);
  const wanted = [...corpus.matched].sort();
  const recorded = readRecordedSet(resolve(REPO_ROOT, opts.recorded));
  const askBytesPerRow = recorded.present && recorded.rows > 0
    ? Math.round([...recorded.map.values()].reduce((total, row) => total + (row.askBytes ?? 0), 0)
      / [...recorded.map.values()].reduce((total, row) => total + (row.tableUnits ?? 0), 0))
    : null;

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let boundaries = 0;
  let askRows = 0;
  let calls = 0;
  let promptTokens = 0;
  let prefixTokens = 0;
  const perSession = [];
  for (const sessionId of wanted) {
    const session = laneSession(db, sessionId);
    const tracker = new UnitTracker({ sessionId, barBytes: BAR_BYTES });
    // Cumulative rendered bytes of provider-visible message nodes per turn; the
    // prefix a boundary would send is every earlier turn's content.
    const visibleByTurn = new Map();
    for (const node of session.nodeByPartId.values()) {
      if (!node.providerVisible) continue;
      visibleByTurn.set(node.turnOrdinal, (visibleByTurn.get(node.turnOrdinal) ?? 0) + node.bytes);
    }
    let cumulative = 0;
    let sessionCalls = 0;
    let sessionTokens = 0;
    for (let turn = 0; turn <= session.lastBoundary; turn++) {
      cumulative += visibleByTurn.get(turn) ?? 0;
      const at = planBoundary(session, turn, tracker);
      if (at.askRows === 0) continue;
      boundaries += 1;
      askRows += at.askRows;
      const tables = Math.ceil(at.askRows / 12);
      calls += tables;
      sessionCalls += tables;
      const askBytes = askBytesPerRow === null ? 0 : askBytesPerRow * at.askRows;
      sessionTokens += tables * Math.ceil((cumulative / TOKEN_QUOTIENT) + (askBytes / TOKEN_QUOTIENT));
      prefixTokens += Math.ceil(cumulative / TOKEN_QUOTIENT);
    }
    promptTokens += sessionTokens;
    perSession.push({ sessionId, turns: session.lastBoundary + 1, calls: sessionCalls,
      promptTokens: sessionTokens });
  }
  db.close();
  return {
    schema: 'racoons-multiturn-fallback-plan/1',
    sessions: wanted.length,
    set: 'chunk 2 matched (39)',
    boundaries,
    askRows,
    calls,
    promptTokens,
    prefixTokens,
    killTimerS: DEFAULT_FALLBACK_KILL_S,
    maxPromptTokens: promptTokens,
    askBytesPerRow,
    askBytesPerRowSource: recorded.present
      ? `gate-2 recorded set (${recorded.rows} OFF rows), mean bytes per row`
      : 'absent: ask bytes not estimated',
    label: 'ESTIMATED-BYTES: prefix from visible store bytes / 4; ask from the recorded mean',
    perSession,
  };
}

function formatReport(output) {
  const lines = [
    'harvest',
    `  answers      ${output.provenance.path}`,
    `  sha256       ${output.provenance.sha256}`,
    `  mode         ${output.provenance.mode ?? 'n/a'} model=${output.provenance.model ?? 'n/a'}`
      + ` tables=${output.counts.tables} refused=${output.counts.refusedTables}`,
    `  manifest     ${output.provenance.corpus.manifest.path} (sha256 ${output.provenance.corpus.manifest.verified
      ? 'matches the recorded one' : 'NOT checked'})`,
    `  corpus       ${output.lane.corpus.path}`
      + ` entry=${output.lane.corpus.counts?.entry ?? 'n/a'}`
      + ` matched=${output.lane.corpus.matched ?? 'n/a'}`
      + ` answered-sessions=${output.counts.answeredSessions}`
      + ` outside=${output.counts.sessionsOutsideCorpus}`,
    `  ask          recorded=${output.ask.recorded.present ? 'present' : 'ABSENT'}`
      + ` matched=${output.ask.matched} mismatched=${output.ask.mismatched.length}`
      + ` absent=${output.ask.absent.length}`,
    `  bytes        ask=${output.ask.askBytes}B prompt=${output.ask.promptBytes}B`
      + ` promptTokens=${output.ask.promptTokens} livePromptTokens=${output.ask.livePromptTokens}`,
    `  verdicts     ${output.counts.verdicts} (forgetall=${output.counts.forgetall}`
      + ` keepall=${output.counts.keepall} keeplines=${output.counts.keeplines})`,
    `  joined       ${output.counts.joined} lane units`
      + ` (${output.counts.foreignRanges} foreign-ranges, ${output.counts.duplicateLaneUnit} duplicate)`,
    `  unmatched    below-lane-bar=${output.counts.belowLaneBar}`
      + ` not-in-corpus=${output.counts.notInCorpus}`
      + ` no-lane-turn=${output.counts.noLaneTurn}`
      + ` no-store-part=${output.counts.noStorePart}`
      + ` unresolved-spike-unit=${output.counts.unresolvedSpikeUnit}`
      + ` never-asked=${output.counts.neverAsked}`
      + ` moments-resolved=${output.counts.moments}`,
    `  decisions    ${output.counts.decisions} whole-unit forgetall decision(s)`
      + ' (the frozen set chunk 8 would apply)',
    `  census       scored=${output.census.scored} censored=${output.census.censored}`
      + ` of ${output.census.sessions} answered session(s)`,
    `  classes      ${Object.entries(output.census.classCounts)
      .sort((a, b) => b[1] - a[1]).map(([label, count]) => `${label}=${count}`).join(' ')}`,
    `  compatibility ${output.compatibility.verdict}`,
  ];
  for (const reason of output.compatibility.reasons) lines.push(`    ${reason}`);
  for (const table of output.tables) {
    const counts = new Map();
    for (const row of table.verdicts) counts.set(row.action, (counts.get(row.action) ?? 0) + 1);
    const joined = table.verdicts.filter(row => row.join === 'unit' || row.join === 'foreign-ranges').length;
    lines.push(`  table        ${table.tableId} units=${table.tableUnits}`
      + ` lastTurn=${table.lastTurn} inCorpus=${table.inCorpus ? 'yes' : 'NO'}`
      + ` ask=${table.recorded?.askBytes ?? 'n/a'}B askSha256=${String(table.askSha256).slice(0, 12)}`
      + ` promptTokens=${table.recorded?.promptTokens ?? 'n/a'}`
      + ` verdicts=${table.verdicts.length} joined=${joined}`
      + ` [${[...counts.entries()].map(([action, count]) => `${action}=${count}`).join(' ')}]`);
  }
  for (const refused of output.refused) {
    lines.push(`  refused      ${refused.tableId} ${refused.code}: ${refused.detail}`);
  }
  for (const row of output.census.rows) {
    lines.push(`  session      ${row.sessionId} scored=${row.scored ? 'yes' : 'no'}`
      + ` tables=${row.tables} verdicts=${row.verdicts} joined=${row.joined}`
      + ` decisions=${row.decisions}`
      + ` censoring=${row.censoring.length === 0 ? 'none' : row.censoring.join('+')}`
      + ` [${Object.entries(row.classes).sort((a, b) => b[1] - a[1])
        .map(([label, count]) => `${label}=${count}`).join(' ')}]`);
  }
  for (const unit of output.units) {
    lines.push(`  unit         ${unit.laneUnitId} action=${unit.action}`
      + ` turn=${unit.turnOrdinal} decisionTurn=${unit.decisionTurn ?? 'n/a'}`
      + ` bytes=${unit.byteLength} from=${unit.tableId}`);
  }
  for (const [code, list] of Object.entries(output.reasons)) {
    for (const detail of list) lines.push(`    ${code} ${JSON.stringify(detail)}`);
  }
  return lines;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.fallbackPlan && !opts.plan) {
    const fallback = fallbackPlan(opts);
    process.stdout.write(`${formatFallbackOnly(fallback).join('\n')}\n`);
    return;
  }
  const { output, failures, compatible } = harvest(opts);
  if (opts.fallbackPlan) {
    process.stdout.write(`${formatFallbackOnly(fallbackPlan(opts)).join('\n')}\n\n`);
  }
  process.stdout.write(`${formatReport(output).join('\n')}\n`);
  if (!opts.plan) {
    const outDir = opts.out === null
      ? join(resolve(REPO_ROOT, opts.db), '..') : resolve(REPO_ROOT, opts.out);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, 'verdicts.json');
    writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`  out          ${outPath}\n`);
  } else {
    process.stdout.write('  out          (--plan: nothing written)\n');
  }
  if (!compatible) {
    process.stdout.write(`  fallback     needed: ${output.compatibility.reasons.length} reason(s);`
      + ' run --fallback-plan for the bounded cost\n');
  }
  for (const failure of failures) {
    process.stderr.write(`${failure.code}: ${failure.message}\n`);
  }
  if (failures.length > 0) process.exitCode = 1;
}

function formatFallbackOnly(fallback) {
  return [
    'fallback-plan',
    `  set          ${fallback.set} sessions=${fallback.sessions}`,
    `  boundaries   ${fallback.boundaries} askRows=${fallback.askRows}`
      + ` calls=${fallback.calls} (ceil(askRows/12) per boundary)`,
    `  cost         promptTokens=${fallback.promptTokens} prefixTokens=${fallback.prefixTokens}`
      + ` askBytesPerRow=${fallback.askBytesPerRow ?? 'n/a'}`,
    `  ceilings     killTimerS=${fallback.killTimerS} maxPromptTokens=${fallback.maxPromptTokens}`,
    `  label        ${fallback.label}`,
    `  ask source   ${fallback.askBytesPerRowSource}`,
  ];
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(2);
  }
}
