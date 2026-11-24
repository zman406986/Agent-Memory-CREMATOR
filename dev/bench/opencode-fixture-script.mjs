#!/usr/bin/env node
/**
 * The mock script the opencode replay bench serves for the synthetic fixture.
 *
 * `opencode-replay.script.json` is the operator's general replay world. It does
 * not fit `fixtures/opencode/replay.db`: the fixture's own prompt is history,
 * and on a replay the host continues the seeded session rather than putting a
 * fresh prompt first. This builder reads the fixture's real message sequence
 * and writes the reply order that mock actually needs. The seeded session ends
 * on a user turn, so the host appends the run's task after every seeded row;
 * the task is the last user message on each main request and is the content
 * key every reply names.
 *
 * Usage:
 *   node dev/bench/opencode-fixture-script.mjs [--out <dir>] [--db <path>]
 *   node dev/bench/opencode-fixture-script.mjs --verify [--out <dir>]
 *
 * It writes `fixture.script.json` beside the fixture by default. `--verify`
 * recomputes the same bytes from the database and exits 1 on any difference;
 * a database or manifest that no longer matches the one the script was built
 * from is refused by name (exit 2), never silently re-described.
 *
 * **What the fixture fixes, and what the script adds.** The fixture is a
 * 62-turn synthetic session with 62 reasoning parts, 12 tool results, 3
 * repeated reads of one path, 2 failed searches, and a largest result that is
 * the host's own whole-file read of the unit file. None of those stored results
 * is removable: the repeated reads are 284 bytes (below the 512-byte product
 * bar), the two oversized reads are each read once, and the failed searches are
 * 93 and 92 bytes. So the script issues the model's own reads into
 * `writeFixtureWorld`, exactly as the shipped replay script does: the first read
 * of `big-b.log` is one whole unit, the second read is its identical twin and
 * its witness, and because the unit is below the host's 50 KiB reader cap
 * `necromancy` returns the whole archived body — a byte-for-byte restore, not a
 * pointer. The seeded copy of that file is the installed host's read rendering,
 * so the seeded result, the first live read and the re-read are the same bytes.
 *
 * **The content keys are the run's task and the fixture's own last result.**
 * Every reply names the task the host appends; the first reply also names the
 * fixture's last tool result, before the script adds a result of its own. Every
 * reply also pins the absolute tool-result count the request carries. The
 * counts are the fixture's 12, plus each read the script adds, minus the unit
 * the at-rest pass replaces with its receipt. A reply that matched only
 * `main_turn` would compare the mock with its own counter (ISSUE-214 P3); these
 * keys are checked against the request's real bytes.
 *
 * **The receipt names a node, not a path.** On this host the receipt target is
 * `oc:<session>:tool:<unit call id>`, so the `{{RECALL_ID:…}}` token is the
 * unit's call id (the same token the shipped replay script uses), never the
 * file's name.
 *
 * **`expectedReads` declares the live reads the task asks for.** The vanilla
 * control groups this run's own reads by file path and requires the counts:
 * `big-b.log` twice, `big-b-twin.txt` once and the auxiliary file once. Every
 * entry also declares the file's fixture sentinel, and a read whose result text
 * does not carry it does not count, so ENOENT, an empty file or another file's
 * bytes cannot satisfy a count (audit 21). The seeded read of the unit file is
 * history and its call id first appears in request 1, so it satisfies no count;
 * the second live read is required (audit 20).
 *
 * Determinism: the database is opened read-only, nothing uses a clock, the
 * network, or the machine's global opencode database, and the JSON is rendered
 * by one function. Two builds of the same fixture are byte-identical.
 *
 * Exit: 0 written or verified; 1 verify mismatch; 2 bad argument, a missing
 * fixture, or a fixture that no longer matches its manifest.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { optionsOf, parseDevArgs } from '../shared/args.mjs';
import {
  fixtureUnitFileText, fixtureUnitSentinel, UNIT_FILE,
} from './opencode-fixture-build.mjs';
import { PRODUCT_BAR_BYTES, READER_CAP_BYTES } from './opencode-removal-fixture.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_OUT = join(HERE, 'fixtures', 'opencode');
export const DB_FILE = 'replay.db';
export const MANIFEST_FILE = 'manifest.json';
export const SCRIPT_FILE = 'fixture.script.json';
/** The mock's model name; the runner composes `mock/<this>` from it. */
export const MODEL = 'mock-model';
/** The synthetic marker every seeded string carries. */
const MARKER = 'RACOONS-SYNTHETIC';
/** The word the last reply says; the runner asserts the final assistant text. */
export const DONE_TEXT = 'DONE';
/** A fixture file's sentinel may not be longer than this in a call-id brand. */
const MAX_SENTINEL = 64;

function refuse(message) {
  process.stderr.write(`opencode-fixture-script.mjs: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  return parseDevArgs(argv, {
    options: optionsOf([
      ['--out', 'string'],
      ['--db', 'string'],
      ['--verify', 'boolean'],
    ]),
    refuse,
    usage: () => 'usage: node dev/bench/opencode-fixture-script.mjs '
      + '[--out <dir>] [--db <path>] [--verify]',
  }).values;
}

/** The last path segment of a stored Windows or POSIX path. */
function baseName(path) {
  const parts = String(path ?? '').split(/[\\/]/u);
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

/** A path stem with every run of non-alphanumerics collapsed: `big-b`. */
function stemOf(name) {
  return String(name).replace(/\.[^.]*$/u, '').replace(/[^A-Za-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '').toLowerCase();
}

/** The call-id brand of a stem: `big_b`. */
function callBrand(stem) {
  return stem.replace(/[^A-Za-z0-9]+/gu, '_');
}

/** One tool part's result text, whichever shape the stored state carries. */
function toolResultText(part) {
  const state = part?.state ?? {};
  const content = Array.isArray(state.content) ? state.content : [];
  const text = content
    .map((item) => (typeof item?.text === 'string' ? item.text : ''))
    .join('');
  if (text.length > 0) return text;
  if (typeof state.output === 'string') return state.output;
  if (typeof state.error?.message === 'string') return state.error.message;
  return '';
}

/** The path or pattern a tool call named, in the host's own spellings. */
function toolPath(input) {
  const value = input?.filePath ?? input?.path ?? input?.pattern ?? input?.command ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The fixture's real message sequence, parsed into the facts the script keys
 * on. Nothing here is invented: every string a reply names is a substring of a
 * message the database holds.
 * @param {string} dbPath
 * @param {string} manifestPath
 */
export function fixtureFacts(dbPath, manifestPath) {
  if (!existsSync(dbPath)) refuse(`fixture database not found at ${dbPath}`);
  if (!existsSync(manifestPath)) refuse(`manifest not found at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const sessionId = manifest.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    refuse(`${manifestPath} names no sessionId`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const session = db.prepare('SELECT * FROM session_v2 WHERE id = ?').get(sessionId);
    if (session === undefined) refuse(`${sessionId} is not a session_v2 row in ${dbPath}`);
    const rows = db.prepare(
      'SELECT seq, id, type, data FROM session_message WHERE session_id = ? ORDER BY seq ASC, id ASC',
    ).all(sessionId);
    const messages = rows.map((row) => {
      const data = JSON.parse(row.data);
      const toolParts = Array.isArray(data.content)
        ? data.content.filter((part) => part?.type === 'tool')
        : [];
      return {
        seq: Number(row.seq),
        id: String(row.id),
        type: String(row.type),
        text: typeof data.text === 'string' ? data.text : null,
        reasoning: Array.isArray(data.content)
          ? data.content.filter((part) => part?.type === 'reasoning')
            .map((part) => (typeof part.text === 'string' ? part.text : ''))
          : [],
        toolResults: toolParts.map((part) => {
          const text = toolResultText(part);
          const firstLine = text.split(/\r?\n/u)[0].trim();
          return {
            seq: Number(row.seq),
            messageId: String(row.id),
            callId: typeof part.id === 'string' ? part.id : null,
            name: typeof part.name === 'string' ? part.name : '',
            status: typeof part.state?.status === 'string' ? part.state.status : '',
            path: toolPath(part.state?.input),
            bytes: Buffer.byteLength(text, 'utf8'),
            text,
            firstLine,
          };
        }),
      };
    });
    const toolResults = messages.flatMap((message) => message.toolResults);
    const userTexts = messages.filter((message) => message.type === 'user')
      .map((message) => message.text).filter((text) => typeof text === 'string' && text.length > 0);
    const reasoningPartCount = messages.reduce((sum, message) => sum + message.reasoning.length, 0);
    const lastUserText = userTexts.length === 0 ? null : userTexts[userTexts.length - 1];
    const lastToolResult = toolResults.length === 0 ? null : toolResults[toolResults.length - 1];
    const largestResult = toolResults.length === 0
      ? null
      : toolResults.reduce((best, row) => (row.bytes > best.bytes ? row : best), toolResults[0]);
    const byPath = new Map();
    for (const row of toolResults) {
      if (row.name !== 'read' || row.path === null) continue;
      byPath.set(row.path, (byPath.get(row.path) ?? 0) + 1);
    }
    const repeatedReads = [...byPath.entries()]
      .filter(([, count]) => count > 1)
      .map(([path, count]) => ({ path, count }));
    const facts = {
      dbPath: resolve(dbPath),
      dbSha256: createHash('sha256').update(readFileSync(dbPath)).digest('hex'),
      sessionId,
      sessionTitle: typeof session.title === 'string' ? session.title : null,
      messageCount: messages.length,
      userTurnCount: messages.filter((message) => message.type === 'user').length,
      assistantTurnCount: messages.filter((message) => message.type === 'assistant').length,
      reasoningPartCount,
      toolResults,
      toolResultCount: toolResults.length,
      lastUserText,
      lastToolResult,
      largestResult,
      repeatedReads,
      failedSearchCount: toolResults.filter((row) =>
        row.name === 'grep' && row.text.includes(`${MARKER}-SEARCH-FAILED-`)).length,
      manifest,
    };
    assertManifest(facts);
    return facts;
  } finally {
    db.close();
  }
}

/**
 * The manifest is the fixture's own declaration. A script built from a
 * different database would name strings that fixture does not hold, so a
 * disagreement is a refusal, not a fresh description.
 * @param {object} facts
 */
function assertManifest(facts) {
  const manifest = facts.manifest;
  const checks = [
    ['sessionId', manifest.sessionId, facts.sessionId],
    ['messageCount', manifest.messageCount, facts.messageCount],
    ['userTurnCount', manifest.userTurnCount, facts.userTurnCount],
    ['assistantTurnCount', manifest.assistantTurnCount, facts.assistantTurnCount],
    ['reasoningPartCount', manifest.reasoningPartCount, facts.reasoningPartCount],
    ['toolResultCount', manifest.toolResultCount, facts.toolResultCount],
    ['largestResultBytes', manifest.largestResultBytes, facts.largestResult?.bytes ?? null],
    ['repeatCount', manifest.repeatCount, facts.repeatedReads.reduce((sum, row) => sum + row.count, 0)],
    ['failedSearchCount', manifest.failedSearchCount, facts.failedSearchCount],
  ];
  const drift = checks.filter(([, declared, actual]) => declared !== actual);
  if (drift.length > 0) {
    refuse(`${facts.dbPath} no longer matches ${join(dirname(facts.dbPath), MANIFEST_FILE)}: `
      + drift.map(([name, declared, actual]) => `${name} declares ${String(declared)} but the `
        + `database holds ${String(actual)}`).join('; '));
  }
  if (facts.lastUserText === null) refuse(`${facts.dbPath} holds no user message to key on`);
  if (facts.lastToolResult === null) refuse(`${facts.dbPath} holds no tool result to key on`);
  if (facts.largestResult === null) refuse(`${facts.dbPath} holds no tool result to size the unit`);
  if (facts.lastToolResult.firstLine.length === 0) {
    refuse(`${facts.dbPath}'s last tool result carries no first line to key on`);
  }
  if (facts.largestResult.name !== 'read' || facts.largestResult.path === null) {
    refuse(`${facts.dbPath}'s largest result is not a read of a named path; a superseded-read `
      + 'lane needs one');
  }
}

/**
 * A sentinel for a file that has no declared one: its first non-empty line of
 * at least eight characters, capped so a read result carries it verbatim. It is
 * declared in the script's `expectedReads`, and the vanilla control requires it
 * inside each counted read's result text (audit 21).
 * @param {string} text
 * @returns {string}
 */
function sentinelOf(text) {
  const line = String(text).split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length >= 8);
  return (line ?? String(text).trim().slice(0, 64)).slice(0, 120);
}

/**
 * The auxiliary file the keepalive read touches: the fixture's own last tool
 * result when that is a small completed read, else the offline stand-in. The
 * text is the fixture's, so the keepalive carries bytes the source held, and
 * its own sentinel is declared so the control can require it.
 * @param {object} facts
 */
function auxiliaryFile(facts) {
  const last = facts.lastToolResult;
  const usable = last.name === 'read' && last.status === 'completed' && last.path !== null
    && last.text.length > 0 && last.text.length <= 4_096;
  if (usable) {
    return {
      name: baseName(last.path),
      text: last.text,
      sentinel: sentinelOf(last.text),
      source: 'fixture-last-tool-result',
    };
  }
  const text = 'offline bench fixture\n';
  return { name: 'hello.txt', text, sentinel: sentinelOf(text), source: 'bench-stand-in' };
}

/**
 * The script the mock serves for this fixture, in the exact reply order the
 * run needs: unit read, superseding read, keepalive read (the measured window
 * opens here), one `necromancy` restore per receipt it then carries, then
 * `DONE`.
 * @param {object} facts
 */
export function buildFixtureScript(facts) {
  const unit = facts.largestResult;
  const unitFile = baseName(unit.path);
  if (unitFile.length === 0) refuse(`the largest result's path ${JSON.stringify(unit.path)} has no file name`);
  if (unitFile !== UNIT_FILE) {
    refuse(`the largest result reads ${unitFile}, but the seeded unit must be ${UNIT_FILE}: a unit `
      + 'whose seeded result is not the host read of the file the script re-reads cannot be '
      + 'superseded byte-for-byte');
  }
  const stem = stemOf(unitFile);
  const brand = callBrand(stem).toUpperCase().replace(/[^A-Z0-9]+/gu, '-');
  const marker = `RS-FIXTURE-UNIT-${brand}`;
  /**
   * The sentinel is the unit file's first line, and the seeded result is the
   * host's read of that file. The two modules derive it through one function, so
   * the seed's line 1 and the world file's line 1 cannot drift.
   */
  const sentinel = fixtureUnitSentinel(unitFile);
  const unitFileBytes = Buffer.byteLength(fixtureUnitFileText(unitFile), 'utf8');
  if (marker.length > MAX_SENTINEL) refuse(`the unit's marker ${marker} is longer than ${MAX_SENTINEL} chars`);
  /**
   * The unit's own seeded result legitimately carries the file sentinel: it is
   * that sentinel's live read. Every **other** stored result must not, or the
   * sentinel would stop naming one file.
   */
  const clash = facts.toolResults.some((row) => row.text.includes(sentinel)
    && row.callId !== unit.callId);
  if (clash) {
    refuse(`the unit sentinel ${sentinel} appears in a fixture result other than the unit's own; `
      + 'a lane sentinel must name only the unit the script creates');
  }
  const unitCall = `call_fixture_${callBrand(stem)}_1_${marker}`;
  const twinCall = `call_fixture_${callBrand(stem)}_2`;
  /**
   * The twin's **distinct** marker (audit 16, P6). The unit file's sentinel is
   * carried by the re-read too, so a control arm that only knows that sentinel
   * proves one sentinel survived, not that a second result did. A second small
   * file, read in the same reply as the twin, carries its own sentinel; the
   * control requires it inside its own result from the twin's landing turn.
   */
  const twinFile = `${stem}-twin.txt`;
  const twinSentinel = `RACOONS-FIXTURE-TWIN-${brand}-0001`;
  const twinMarkerCall = `call_fixture_${callBrand(stem)}_twin_marker`;
  if (!unitCall.includes(marker)) refuse(`the unit call ${unitCall} does not carry ${marker}`);
  const twinClash = facts.toolResults.some((row) => row.text.includes(twinSentinel));
  if (twinClash) {
    refuse(`the twin sentinel ${twinSentinel} already appears in the fixture's own results; a `
      + 'twin marker must name only the file the script creates');
  }
  const auxiliary = auxiliaryFile(facts);
  /**
   * The fixture's seeded read of the unit file is the first of the run's two
   * restorable recalls; the script's first live read is the second. The task
   * asks for one `necromancy` call per `[not retained]` receipt in context, so
   * the restore reply names both receipts: the seeded read's own call id (the
   * receipt's target) and the scripted first read's call id.
   */
  if (typeof unit.callId !== 'string' || unit.callId.length === 0) {
    refuse(`the largest result ${JSON.stringify(unit.path)} names no call id; a seeded receipt `
      + 'needs the call id its target carries');
  }
  /**
   * The task names every step in order, and says the second read is a read of
   * the **same path**. The old sentence ("read it again beside the twin") let a
   * model read only the twin, which never supersedes the first read and never
   * creates the removable unit this run exists to measure.
   */
  const taskText = `Do these steps in order. 1) Read ${unitFile}. 2) Read ${unitFile} again at `
    + `the same path; this second read is required, and it is a read of ${unitFile}, not of `
    + `${twinFile}. 3) Read ${twinFile}. 4) Read ${auxiliary.name}. 5) Call necromancy once `
    + `for each [not retained] receipt in context. 6) Reply with exactly: ${DONE_TEXT}`;
  const lastTool = facts.lastToolResult.firstLine;
  const unitPath = `{{WORK}}/${unitFile}`;
  const twinPath = `{{WORK}}/${twinFile}`;
  const auxPath = `{{WORK}}/${auxiliary.name}`;
  /**
   * The live reads the task asks for, in order. The control requires these
   * counts and each result's own message from its landing request onward; the
   * seeded read of the unit file is history and does not count toward them
   * (audit 20). The values are minimums. Each entry declares the file's own
   * fixture sentinel: a live read whose result text does not carry it (ENOENT,
   * an empty file, or another file's bytes) does not count (audit 21).
   */
  const expectedReads = {};
  const addExpectedRead = (name, count, readSentinel) => {
    const prior = expectedReads[name];
    expectedReads[name] = {
      count: (prior?.count ?? 0) + count,
      sentinel: readSentinel,
    };
  };
  addExpectedRead(unitFile, 2, sentinel);
  addExpectedRead(twinFile, 1, twinSentinel);
  addExpectedRead(auxiliary.name, 1, auxiliary.sentinel);
  // The seeded session ends on a user turn, so the host appends the run's task
  // after every seeded row and the task is the last user message on each main
  // request. Keying on the fixture's own last user text would name a message
  // that is no longer last; every reply names the task instead. The last tool
  // result moves with the script's own reads, so it is not a stable key.
  const key = (turn, count, extra = {}) => ({
    main_turn: turn,
    ...(count === null ? {} : { tool_results_count: count }),
    last_user_contains: [taskText],
    ...extra,
  });
  // The fixture's own last result is still a useful key on the first request,
  // which runs before the script adds any result of its own.
  const firstKey = key(0, facts.toolResultCount, { last_tool_result_contains: [lastTool] });
  // The counts the requests carry. 12 seeded results. The first scripted read
  // is already a later read of the seeded unit's path, with the same bytes, so
  // the at-rest pass after that turn replaces the *seeded* copy with a receipt
  // while the live read adds one: the next request still carries 12. The re-read
  // then supersedes the scripted first read (-1) while the re-read and the twin
  // marker add two: 13. The keepalive adds one: 14. The restore turn issues one
  // `necromancy` call per receipt in context (the seeded read and the scripted
  // first read), so the DONE request carries both results: 16.
  const count0 = facts.toolResultCount;
  const count1 = count0;
  const count2 = count1 + 2 - 1;
  const count3 = count2 + 1;
  const count4 = count3 + 2;
  const replies = [
    {
      name: 'fixture-unit-read-1',
      match: firstKey,
      reply: {
        type: 'tool_use',
        reasoning: 'The seeded session is history, so the run starts from its own new work. '
          + `Read ${unitFile} once; the whole ${String(unit.bytes)}-byte result is one unit, and `
          + 'it is below the host reader cap, so a later restore can return all of it.',
        text: `Reading ${unitFile} once.`,
        calls: [{ id: unitCall, name: 'read', input: { path: unitPath } }],
      },
    },
    {
      name: 'fixture-unit-read-2',
      match: key(1, count1),
      reply: {
        type: 'tool_use',
        reasoning: 'Steps 2 and 3: the second read is the required re-read of the same path, so '
          + 'the earlier copy is exactly superseded — identical bytes, no write between, so the '
          + `first read is the removable unit and this one is its surviving twin. Read ${twinFile} `
          + 'as its own step so the control has a second, distinct result to find: the twin '
          + 'sentinel is not the unit sentinel.',
        text: `Reading ${unitFile} again, then ${twinFile}.`,
        calls: [
          { id: twinCall, name: 'read', input: { path: unitPath } },
          { id: twinMarkerCall, name: 'read', input: { path: twinPath } },
        ],
      },
    },
    {
      name: 'fixture-keepalive-read',
      match: key(2, count2),
      reply: {
        type: 'tool_use',
        reasoning: 'The re-read has landed, so the at-rest pass can remove the first copy. Read '
          + `the fixture's small ${auxiliary.name} to send one more request after that removal: `
          + 'the receipt and the surviving twin must both be on this request, or the removal was '
          + 'never carried by the host.',
        text: `Reading ${auxiliary.name} to keep the run moving.`,
        calls: [{ id: 'call_fixture_keepalive', name: 'read', input: { path: auxPath } }],
      },
    },
    {
      name: 'fixture-restore-receipts',
      match: key(3, count3),
      reply: {
        type: 'tool_use',
        reasoning: 'Two receipts are in context: the seeded read of the unit file and the '
          + 'scripted first read. Restore both, one necromancy call per receipt, by the recall id '
          + 'each receipt names; each archive is below the reader cap, so necromancy must return '
          + 'every byte.',
        text: `Restoring both removed reads of ${unitFile}.`,
        calls: [
          { id: 'call_fixture_recall_seeded', name: 'necromancy',
            input: { id: `{{RECALL_ID:${unit.callId}}}` } },
          { id: 'call_fixture_recall_unit', name: 'necromancy',
            input: { id: `{{RECALL_ID:${unitCall}}}` } },
        ],
      },
    },
    {
      name: 'fixture-done',
      match: key(4, count4),
      reply: {
        type: 'text',
        reasoning: 'Both removed reads were carried on later requests with their receipts and '
          + 'restored byte for byte. Nothing else is asked for, so answer with the exact word the '
          + 'bounded task names.',
        text: DONE_TEXT,
      },
    },
  ];
  return {
    model: MODEL,
    title: facts.sessionTitle ?? 'opencode fixture replay',
    task: taskText,
    fixture: {
      readerCapBytes: READER_CAP_BYTES,
      productBarBytes: PRODUCT_BAR_BYTES,
      files: [
        { name: unitFile, sentinel, bytes: unitFileBytes },
        { name: twinFile, sentinel: twinSentinel, bytes: PRODUCT_BAR_BYTES + 808 },
      ],
      auxiliary: [{
        name: auxiliary.name,
        text: auxiliary.text,
        /** The line a counted live read of this file must carry (audit 21). */
        sentinel: auxiliary.sentinel,
      }],
      lanes: [{
        name: 'fixture-unit-whole-restore',
        rule: 'superseded-read',
        unitCalls: [unitCall],
        supersedingCalls: [twinCall],
        unitFiles: [unitFile],
        markerSentinels: [marker],
        /** The twin's own result, and the distinct marker file it also reads. */
        twinCalls: [twinCall, twinMarkerCall],
        twinFiles: [unitFile, twinFile],
      }],
    },
    /**
     * The counts the vanilla control requires of this run's **live** reads, by
     * file path. The seeded read of the unit file is not counted; the second
     * live read of it is required, so a control with only one live read fails
     * even though the file bytes are on the wire.
     */
    expectedReads,
    replies,
  };
}

/** The one rendering: two-space JSON plus a trailing newline. */
export function scriptText(script) {
  return `${JSON.stringify(script, null, 2)}\n`;
}

/**
 * Recompute the script and compare the exact bytes with the file on disk.
 * @param {{dbPath: string, scriptPath: string}} input
 * @returns {{ok: boolean, problems: string[], bytes: number}}
 */
export function verifyFixtureScript(input) {
  if (!existsSync(input.scriptPath)) {
    return { ok: false, problems: [`${input.scriptPath} does not exist`], bytes: 0 };
  }
  const facts = fixtureFacts(input.dbPath, join(dirname(input.dbPath), MANIFEST_FILE));
  const expected = scriptText(buildFixtureScript(facts));
  const actual = readFileSync(input.scriptPath, 'utf8');
  if (actual === expected) return { ok: true, problems: [], bytes: Buffer.byteLength(expected) };
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const at = expectedLines.findIndex((line, index) => line !== actualLines[index]);
  const line = at < 0 ? Math.min(expectedLines.length, actualLines.length) : at;
  return {
    ok: false,
    problems: [
      `${input.scriptPath} is not the script this fixture produces; first difference at line `
        + `${String(line + 1)}: expected ${JSON.stringify(expectedLines[line] ?? '<eof>')}, `
        + `found ${JSON.stringify(actualLines[line] ?? '<eof>')}`,
    ],
    bytes: Buffer.byteLength(actual),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = opts.db === undefined ? join(DEFAULT_OUT, DB_FILE) : resolve(opts.db);
  const outDir = opts.out === undefined ? DEFAULT_OUT : resolve(opts.out);
  const scriptPath = join(outDir, SCRIPT_FILE);
  if (opts.verify === true) {
    const result = verifyFixtureScript({ dbPath, scriptPath });
    if (result.ok !== true) {
      process.stderr.write(`opencode-fixture-script.mjs: ${result.problems.join('; ')}\n`);
      process.exit(1);
    }
    process.stdout.write(`verified ${scriptPath} (${String(result.bytes)} bytes)\n`);
    return;
  }
  const facts = fixtureFacts(dbPath, join(dirname(dbPath), MANIFEST_FILE));
  const script = buildFixtureScript(facts);
  const text = scriptText(script);
  mkdirSync(outDir, { recursive: true });
  const before = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : null;
  if (before === text) {
    process.stdout.write(`unchanged ${scriptPath} (${String(Buffer.byteLength(text))} bytes)\n`);
    return;
  }
  writeFileSync(scriptPath, text, 'utf8');
  process.stdout.write(`wrote ${scriptPath} (${String(Buffer.byteLength(text))} bytes, `
    + `${String(script.replies.length)} replies, unit ${script.fixture.files[0].name} `
    + `${String(script.fixture.files[0].bytes)} bytes)\n`);
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
