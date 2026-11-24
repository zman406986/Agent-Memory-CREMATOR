#!/usr/bin/env node
/**
 * The ledger growth behind `appliedRewritesAt` (ISSUE-300 item 18).
 *
 * The adapter's scan walks every ledger event for the session at each request
 * boundary and at each ask apply. Under `rewriteHistory: false` the host
 * rebuilds every request from its own store, so a stored `forgetall` verdict is
 * re-applied on every request and writes a new applied row each time. The
 * ledger is O(requests), not O(crossings), and this harness measures that
 * instead of asserting it from a comment.
 *
 * No host, no model, no network: the real mount drives the same `transform`
 * seam the plugin test uses, with the host's rebuild modelled as a fresh clone
 * of the same base conversation per request. `askGenerate` answers every pending
 * unit's row `forgetall` in the product's `jsonl-20-nokeepall` wire shape (one
 * JSON object per line); every later request re-applies the stored verdict
 * without asking again.
 *
 * Usage: node dev/bench/opencode-ledger-scale.mjs [--requests 1050]
 * Output: one JSON record on stdout with the measured counts and timings.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createOpencodeMount } from 'cremator-opencode';
import { readJsonl20NoKeepallAnswer } from '@cremator/core';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';

const sessionId = 'ses_ledger_scale';

function fail(message) {
  process.stderr.write(`opencode-ledger-scale.mjs: ${message}\n`);
  process.exit(2);
}

/**
 * The reply this harness gives the ask: one JSON object per line, one line per
 * asked row, every row a whole-unit `forgetall`. The rows are the caller's own
 * table rows, so a row the harness shipped is never silently unanswered by a
 * pattern that missed its rendered line.
 * `jsonl-20-nokeepall` refuses the old shape (one multi-key object, a bare
 * string `forgetall`), so the text is read back through core's own reader
 * before it is returned: a table this build cannot answer fails here instead of
 * measuring zero removals and reporting a vacuous run.
 * @param {readonly { readonly index: number }[]} rows the table rows the ask offered
 * @returns {string} one object per line; `''` for a table with no rows
 */
export function askForgetAllReply(rows) {
  const indices = rows.map(row => row.index);
  const text = indices.map(index => JSON.stringify({
    [String(index)]: { forgetall: true, summary: `stale note ${String(index)}` },
  })).join('\n');
  return checkedForgetAllReply(text, indices);
}

/**
 * Refuse a reply core's reader does not read as one answered `forgetall` per
 * asked index; the text is returned unchanged otherwise. An omitted index reads
 * `missing-index` and a row that answers `keepall` or `keeplines` reads its own
 * refusal, so neither can pass as a silent no-op.
 * @param {string} text
 * @param {readonly number[]} indices
 * @returns {string}
 */
export function checkedForgetAllReply(text, indices) {
  const reading = readJsonl20NoKeepallAnswer(text, indices);
  const refused = reading.rows.filter(row => row.status !== 'answered'
    || row.answer.action !== 'forgetall');
  if (refused.length > 0) {
    throw new Error(`the built reply is not readable by the product reader: `
      + `${JSON.stringify(refused)}`);
  }
  return text;
}

/** The flag table (ISSUE-392): the shared parser binds values, never the next flag. */
const LEDGER_OPTIONS = optionsOf([
  ['--requests', 'string'], ['--units', 'string'], ['--grow', 'boolean'],
]);

const LEDGER_USAGE = 'usage: opencode-ledger-scale.mjs [--requests <n>] [--units <n>] [--grow]\n';

export function parseArgs(argv) {
  // Throws with a plain message; `main` hands it to `fail` for the script's
  // stderr prefix and exit 2, so the CLI refusal path is unchanged. The unknown
  // wording is the helper's default `unknown argument <token>`, which is exactly
  // this script's old unquoted text, so no `unknown` hook is needed.
  const refuse = (message) => { throw new Error(message); };
  let requests = 1050;
  let units = 1;
  let grow = false;
  const { values } = parseDevArgs(argv, {
    options: LEDGER_OPTIONS,
    refuse,
    help: LEDGER_USAGE,
  });
  if (values.requests !== undefined) requests = Number(values.requests);
  if (values.units !== undefined) units = Number(values.units);
  if (values.grow === true) grow = true;
  if (!Number.isSafeInteger(requests) || requests < 2) {
    refuse('--requests takes an integer >= 2');
  }
  if (!Number.isSafeInteger(units) || units < 1 || units > 8) {
    refuse('--units takes an integer 1..8');
  }
  if (grow && units !== 1) {
    refuse('--grow adds one unit per request; do not combine it with --units');
  }
  return { requests, units, grow };
}

/**
 * `units` large reads the product may table: each above the 512-byte unit floor
 * and holding distinct bytes, so no L1 family removes them for us and every
 * unit reaches the ask's removable set.
 */
function unitMessages(unit) {
  const call = `call_${String(unit)}`;
  return [
    { id: `msg_a_call_${String(unit)}`, role: 'assistant', content: [
      { type: 'tool-call', id: call, name: 'read', input: { filePath: `NOTE_${String(unit)}.md` } },
    ] },
    { id: `msg_t_${String(unit)}`, role: 'tool', content: [
      { type: 'tool-result', id: call, name: 'read',
        result: { type: 'text',
          value: `# Note ${String(unit)}\n\n${`body${String(unit)}-`.repeat(600)}\n` } },
    ] },
  ];
}

function baseConversation(units) {
  const messages = [
    { id: 'msg_u1', role: 'user', content: [{ type: 'text', text: 'Read every note.' }] },
  ];
  for (let unit = 1; unit <= units; unit += 1) messages.push(...unitMessages(unit));
  messages.push({ id: 'msg_a_end', role: 'assistant',
    content: [{ type: 'text', text: 'Read them.' }] });
  return messages;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
  const { requests, units, grow } = opts;
  const root = mkdtempSync(join(tmpdir(), 'racoons-oc-ledger-scale-'));
  const records = [];
  let askCalls = 0;
  /**
   * The unit rows each ask still offers: every unit this harness has shipped
   * that no ask has answered yet. The harness knows the units it put in the
   * array, so the asked rows come from that list, never from a pattern over the
   * rendered prompt. A fixed run asks its units once; a growing run asks the one
   * new unit each request.
   */
  let shipped = grow ? 0 : units;
  let answered = 0;
  const pendingRows = () => {
    const rows = [];
    for (let index = answered + 1; index <= shipped; index += 1) rows.push({ index });
    return rows;
  };
  let mount = null;
  try {
    mount = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      askGrammar: 'prune-two-option',
      askGenerate: async () => {
        askCalls += 1;
        // One object per line, `forgetall` with a summary: the grammar the
        // product table asks for, and every pending row answered.
        const text = askForgetAllReply(pendingRows());
        answered = shipped;
        return { text };
      },
      journal: record => records.push(record),
    });
    const base = grow ? [
      { id: 'msg_u1', role: 'user', content: [{ type: 'text', text: 'Read every note.' }] },
    ] : baseConversation(units);
    let growth = 0;
    /**
     * Open the session first so the ledger wrapper is installed before the
     * measured requests. The warm-up transforms a one-message array and writes
     * no applied row; its single scan walks an empty ledger.
     */
    await mount.transform(sessionId, [
      { id: 'msg_warm', role: 'user', content: [{ type: 'text', text: 'warm up' }] },
    ]);
    const warmEntry = mount.sessions.get(sessionId);
    let scans = 0;
    let scanEvents = 0;
    let worstScanEvents = 0;
    let worstScanMs = 0;
    let totalScanMs = 0;
    const original = warmEntry.ledger.events.bind(warmEntry.ledger);
    warmEntry.ledger.events = async function* counted(id) {
      const at = performance.now();
      let count = 0;
      for await (const event of original(id)) {
        count += 1;
        yield event;
      }
      const elapsed = performance.now() - at;
      scans += 1;
      scanEvents += count;
      if (count > worstScanEvents) worstScanEvents = count;
      if (elapsed > worstScanMs) worstScanMs = elapsed;
      totalScanMs += elapsed;
    };
    const started = performance.now();
    for (let request = 0; request < requests; request += 1) {
      /**
       * The host replaces the adapter's rewritten array with its own rebuilt
       * request, so every transform sees the host's store plus the new turn it
       * just appended; the clone is that rebuilt request. `--grow` models one new
       * tool result per request, the shape a real task's turns add; the fixed
       * run repeats the same units.
       */
      if (grow) {
        growth += 1;
        base.push(...unitMessages(growth));
        shipped = growth;
      }
      const rebuilt = structuredClone(base);
      await mount.transform(sessionId, rebuilt);
    }
    const elapsedMs = performance.now() - started;
    let ledgerEvents = 0;
    let appliedRows = 0;
    for await (const { event } of original(sessionId)) {
      ledgerEvents += 1;
      if (event.kind === 'applied') appliedRows += 1;
    }
    const askApplyLines = records.filter(record => record.kind === 'ask-apply').length;
    const output = {
      requests,
      units,
      grow,
      askGenerateCalls: askCalls,
      ledgerEvents,
      appliedRows,
      askApplyLines,
      scans,
      scanEventsWalked: scanEvents,
      worstScanEvents,
      averageScanEvents: scans === 0 ? 0 : scanEvents / scans,
      worstScanMs: Math.round(worstScanMs * 1000) / 1000,
      totalScanMs: Math.round(totalScanMs * 1000) / 1000,
      elapsedMs: Math.round(elapsedMs),
      basis: 'real mount, host rebuild modelled as a fresh clone per request; every stored '
        + 'forgetall verdict re-applied per request; no host, no model, no network',
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    if (mount !== null) await mount.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// A direct run drives the harness; an import (the parser regression test) does not.
if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
