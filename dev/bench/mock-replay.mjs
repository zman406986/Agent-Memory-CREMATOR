#!/usr/bin/env node
/**
 * Mock-replay path-map layer (ISSUE-023, chunk 1).
 *
 * `dev/dsh-rig/replay.mjs` converts a zcode `transcript.jsonl` into a mock
 * script, but it rewrites every recorded file path to a synthetic
 * `replay/file-N.ext`. A bench arm lives in a different tree, so a replayed
 * `read`/`edit` would target a path that does not exist there and fail
 * silently: a failed tool result still advances `tool_results_count`, so the
 * script keeps matching and the run looks healthy for the wrong reason.
 *
 * This CLI is that missing layer. It does not reimplement the converter; it
 * imports it (`convertTranscript`, `canonicalScript`, `leakScan`,
 * `CONVERTER_VERSION` from `dev/dsh-rig/replay.mjs`), then:
 *
 *   1. converts `--record <transcript.jsonl>` with `--text-cap` / `--max-replies`;
 *   2. loads `--map <map.json>` and checks it belongs to this record
 *      (source sha256, converter version, both caps);
 *   3. rewrites every `replay/file-N.ext` in the converted replies to the
 *      arm-relative target the map names;
 *   4. `--check` prints per-turn mapping stats, fails on any unmapped
 *      read/edit/write path and on any leak the converter's own leak scan
 *      finds in the rewritten script (or in the map itself).
 *
 * Usage:
 *   node dev/bench/mock-replay.mjs --record <transcript.jsonl> --map <map.json>
 *        [--check] [--out <script.json>] [--text-cap n] [--max-replies n]
 *        [--text-mode placeholder|redact] [--arm-root <arm dir>]
 *        [--require-targets] [--json]
 *
 *   node dev/bench/mock-replay.mjs --record <transcript.jsonl> --check   # fails:
 *        # a check needs the map it is checking against.
 *
 * Reply text defaults to `placeholder` (a `<replay turn N: X chars>` marker):
 * a committed or replayed script carries no recorded prose. `redact` keeps
 * prose with secrets/paths/names replaced; it is for a scratchpad script only.
 *
 * `--arm-root` additionally verifies each mapped target exists as a file in
 * that arm (either arm; both are byte-identical trees). It is reported as a
 * stat, and is fatal only with `--require-targets`. Without an arm root the
 * check is reported as `not-checked`, never as passed.
 *
 * Exit codes: 0 clean; 1 an unmapped read/edit/write path remains;
 * 2 bad arguments, unreadable record, or a map that does not match the run;
 * 3 a leak survived (script or map), mirroring `replay.mjs --check`.
 *
 * Map shape (committed, no recorded prose — paths and hashes only):
 *   {
 *     "sourceSha256": "<sha256 of the transcript bytes>",
 *     "sourcePath": "~/.zcode/cli/agents/<sess>/<agent>/transcript.jsonl",
 *     "converterVersion": 1,
 *     "textCap": 4000,
 *     "maxReplies": 24,
 *     "pathMap": { "replay/file-1.ext": "<arm-relative path>" },
 *     "notes": ["..."]
 *   }
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CONVERTER_VERSION, canonicalScript, convertTranscript, leakScan,
} from '../dsh-rig/replay.mjs';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(BENCH_DIR));
const MOCK = join(REPO_ROOT, 'dev', 'dsh-rig', 'mock-messages.mjs');
/** A record larger than this is refused: the converter holds it in memory. */
const MAX_RECORD_BYTES = 256 * 1024 * 1024;
/** Synthetic keys the converter can emit, with or without an extension. */
const SYNTHETIC = /^replay\/file-[1-9][0-9]*(?:\.[A-Za-z0-9]{1,8})?$/u;
const TEXT_MODES = new Set(['redact', 'placeholder']);
/** Tools whose input names a file the converter rewrites. */
const PATH_TOOLS = new Set(['read', 'write', 'edit']);

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const MOCK_REPLAY_OPTIONS = optionsOf([
  ['--record', 'string'],
  ['--map', 'string'],
  ['--out', 'string'],
  ['--text-cap', 'string', 'textCap'],
  ['--max-replies', 'string', 'maxReplies'],
  ['--text-mode', 'string', 'textMode'],
  ['--arm-root', 'string', 'armRoot'],
  ['--check', 'boolean'],
  ['--require-targets', 'boolean', 'requireTargets'],
  ['--json', 'boolean'],
]);

const MOCK_REPLAY_USAGE = 'usage: mock-replay.mjs --record <transcript.jsonl> --map <map.json>\n'
  + '       [--check] [--out <script.json>] [--text-cap n] [--max-replies n]\n'
  + '       [--text-mode placeholder|redact] [--arm-root <arm dir>]\n'
  + '       [--require-targets] [--json]\n';

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: MOCK_REPLAY_OPTIONS,
    refuse,
    help: MOCK_REPLAY_USAGE,
  });
  const opts = {
    record: values.record ?? null,
    map: values.map ?? null,
    out: values.out ?? null,
    textCap: values.textCap === undefined ? null : Number(values.textCap),
    maxReplies: values.maxReplies === undefined ? null : Number(values.maxReplies),
    textMode: values.textMode ?? 'placeholder',
    armRoot: values.armRoot ?? null,
    check: values.check ?? false,
    requireTargets: values.requireTargets ?? false,
    json: values.json ?? false,
  };
  if (opts.record === null) refuse('mock-replay.mjs: --record is required');
  if (opts.map === null) refuse('mock-replay.mjs: --map is required (the path map is this mode\'s input)');
  if (opts.textCap !== null && (!Number.isInteger(opts.textCap) || opts.textCap < 0)) {
    refuse('mock-replay.mjs: --text-cap must be a non-negative integer');
  }
  if (opts.maxReplies !== null && (!Number.isInteger(opts.maxReplies) || opts.maxReplies < 1)) {
    refuse('mock-replay.mjs: --max-replies must be a positive integer');
  }
  if (!TEXT_MODES.has(opts.textMode)) refuse(`mock-replay.mjs: --text-mode must be one of ${[...TEXT_MODES].join('|')}`);
  if (opts.requireTargets && opts.armRoot === null) refuse('mock-replay.mjs: --require-targets needs --arm-root');
  if (opts.check && opts.armRoot === null) {
    process.stderr.write('mock-replay.mjs: note: no --arm-root; mapped targets are not checked against a tree\n');
  }
  opts.record = resolve(opts.record);
  opts.map = resolve(opts.map);
  if (opts.out !== null) opts.out = resolve(opts.out);
  if (opts.armRoot !== null) opts.armRoot = resolve(opts.armRoot);
  return opts;
}

function sha256FileBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Parse and validate the map. Every failure is exit 2: a map that does not
 * belong to this record would rewrite paths against the wrong tree.
 * Exported: with `rewriteScript`, these two are the whole seam chunk 2 needs
 * (`bench-run.mjs --provider mock-replay` applies the same map in-process).
 * @param {string} text - map bytes as utf8.
 * @param {string} file - for messages only.
 * @param {{sha256: string, textCap: number, maxReplies: number, textMode: string}} run
 * @returns {{doc: object, sha256: string}}
 */
export function loadReplayMap(text, file, run) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    refuse(`mock-replay.mjs: map ${file} is not JSON: ${error.message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    refuse(`mock-replay.mjs: map ${file} must be a JSON object`);
  }
  if (doc.sourceSha256 !== run.sha256) {
    refuse(`mock-replay.mjs: map sourceSha256 ${JSON.stringify(doc.sourceSha256)} does not match the record `
      + `(${run.sha256}); the map belongs to another record`);
  }
  if (doc.converterVersion !== CONVERTER_VERSION) {
    refuse(`mock-replay.mjs: map converterVersion ${JSON.stringify(doc.converterVersion)} != ${CONVERTER_VERSION}`);
  }
  for (const key of ['textCap', 'maxReplies']) {
    if (!Number.isInteger(doc[key])) refuse(`mock-replay.mjs: map ${key} must be an integer`);
    if (doc[key] !== run[key]) {
      refuse(`mock-replay.mjs: map ${key} ${doc[key]} does not match this run's ${run[key]}; `
        + 'pass the same flag value or edit the map');
    }
  }
  const pathMap = doc.pathMap;
  if (pathMap === null || typeof pathMap !== 'object' || Array.isArray(pathMap)) {
    refuse('mock-replay.mjs: map pathMap must be an object');
  }
  // The synthetic key form is a function of the text mode: `placeholder`
  // emits `replay/file-N.ext`, `redact` emits `replay/<basename>`. A map built
  // for one mode cannot be applied in the other, so a map that states its mode
  // binds the run to it.
  if (doc.textMode !== undefined) {
    if (!TEXT_MODES.has(doc.textMode)) refuse(`mock-replay.mjs: map textMode ${JSON.stringify(doc.textMode)} is not redact|placeholder`);
    if (doc.textMode !== run.textMode) {
      refuse(`mock-replay.mjs: map textMode ${doc.textMode} does not match this run's ${run.textMode}; `
        + 'a path map is only valid for the text mode it was built with');
    }
  }
  for (const [key, target] of Object.entries(pathMap)) {
    if (!SYNTHETIC.test(key)) refuse(`mock-replay.mjs: map key ${JSON.stringify(key)} is not a synthetic replay path`);
    if (typeof target !== 'string' || target === '') refuse(`mock-replay.mjs: map target for ${key} must be a non-empty string`);
    if (target.startsWith('/') || /^[A-Za-z]:/u.test(target)) {
      refuse(`mock-replay.mjs: map target ${JSON.stringify(target)} is absolute; the arm-relative form is required`);
    }
    if (target.includes('\\')) refuse(`mock-replay.mjs: map target ${JSON.stringify(target)} uses a backslash; use forward slashes`);
    if (target.split('/').some((part) => part === '..' || part === '')) {
      refuse(`mock-replay.mjs: map target ${JSON.stringify(target)} has an empty or ".." segment`);
    }
  }
  return { doc, sha256: sha256FileBytes(Buffer.from(text, 'utf8')) };
}

/**
 * Rewrite every synthetic path in the converted script.
 * Exported for chunk 2 (`bench-run.mjs --provider mock-replay`), which needs
 * the same rewrite and the same stats without spawning a CLI.
 * @param {object} script - output of convertTranscript.
 * @param {Record<string, string>} pathMap
 * @returns {{turns: object[], toolNames: Record<string, number>, totals: object, unused: string[]}}
 */
export function rewriteScript(script, pathMap) {
  const turns = [];
  const toolNames = {};
  const used = new Set();
  const totals = {
    calls: 0,
    path_calls: 0,
    mapped: 0,
    unmapped: 0,
    pathless: 0,
    by_tool: {},
  };
  for (const reply of script.replies) {
    const calls = Array.isArray(reply.reply.calls) ? reply.reply.calls : [];
    const perCall = [];
    for (const call of calls) {
      totals.calls += 1;
      toolNames[call.name] = (toolNames[call.name] ?? 0) + 1;
      const input = call.input !== null && typeof call.input === 'object' ? call.input : {};
      const listed = typeof input.file_path === 'string' ? input.file_path : null;
      let entry = { tool: call.name, path: null, target: null };
      if (listed !== null) {
        totals.path_calls += 1;
        const bucket = totals.by_tool[call.name] ?? { mapped: 0, unmapped: 0, pathless: 0 };
        if (pathMap[listed] !== undefined) {
          input.file_path = pathMap[listed];
          used.add(listed);
          totals.mapped += 1;
          bucket.mapped += 1;
          entry = { tool: call.name, path: listed, target: input.file_path };
        } else {
          totals.unmapped += 1;
          bucket.unmapped += 1;
          entry = { tool: call.name, path: listed, target: null };
        }
        totals.by_tool[call.name] = bucket;
      } else if (PATH_TOOLS.has(call.name)) {
        // A path tool without a file_path cannot be mapped or verified.
        totals.pathless += 1;
        const bucket = totals.by_tool[call.name] ?? { mapped: 0, unmapped: 0, pathless: 0 };
        bucket.pathless += 1;
        totals.by_tool[call.name] = bucket;
        entry = { tool: call.name, path: null, target: null };
      }
      perCall.push(entry);
    }
    turns.push({ reply: reply.name, type: reply.reply.type, calls: perCall });
  }
  const unused = Object.keys(pathMap).filter((key) => !used.has(key));
  return { turns, toolNames, totals, unused };
}

/** Human-readable stats; the JSON form is also emitted with `--json`. */
function printHuman(summary) {
  const lines = [];
  const comma = (n) => n.toLocaleString('en-US');
  lines.push(`mock-replay ${summary.mode} — ${summary.record.name}`);
  lines.push(`  record   ${comma(summary.record.bytes)} B  sha256 ${summary.record.sha256}`);
  lines.push(`  map      ${summary.map.name}  sha256 ${summary.map.sha256}  converter v${summary.map.converterVersion}`);
  lines.push(`           textCap ${summary.map.textCap}  maxReplies ${summary.map.maxReplies}  entries ${summary.map.entries}`);
  const t = summary.turns;
  lines.push(`  turns    ${t.model_requests} requests / ${t.completions} completions / ${t.scripted} scripted `
    + `/ ${t.truncated_by_max_replies} truncated / ${t.dropped_after_blocker} dropped`
    + `${t.blocker === null ? '' : `  (blocker ${t.blocker})`}`);
  const names = Object.entries(summary.calls.tool_names).map(([name, count]) => `${name} ${count}`).join(', ');
  lines.push(`  calls    ${summary.calls.total} scripted (${names === '' ? 'none' : names})`);
  for (const turn of summary.calls.turns) {
    const shown = turn.calls.length === 0
      ? '—'
      : turn.calls.map((call) => (call.path === null ? call.tool : `${call.tool} ${call.path} -> ${call.target ?? 'UNMAPPED'}`)).join('; ');
    lines.push(`  ${turn.reply.padEnd(14)} ${shown}`);
  }
  const p = summary.paths;
  lines.push(`  paths    ${p.unique} unique / ${p.mapped} mapped / ${p.unmapped} unmapped`
    + `  (read+edit+write calls: ${p.path_calls})`);
  if (p.unmapped > 0) {
    lines.push(`  UNMAPPED ${p.unmapped_list.join(', ')}`);
  }
  for (const [tool, bucket] of Object.entries(p.by_tool)) {
    lines.push(`           ${tool}: mapped ${bucket.mapped}, unmapped ${bucket.unmapped}, pathless ${bucket.pathless}`);
  }
  lines.push(`  targets  ${summary.targets.state}${summary.targets.missing.length === 0 ? '' : `  missing: ${summary.targets.missing.join(', ')}`}`);
  if (summary.map.unused.length > 0) lines.push(`  unused   ${summary.map.unused.join(', ')}`);
  lines.push(`  leaks    script ${summary.leaks.script}, map ${summary.leaks.map}`);
  for (const hit of summary.leaks.hits) lines.push(`  LEAK ${hit.kind}: ${hit.sample}`);
  lines.push(`  verdict  ${summary.verdict}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let bytes;
  try {
    bytes = readFileSync(opts.record);
  } catch (error) {
    refuse(`mock-replay.mjs: cannot read record ${opts.record}: ${error.message}`);
  }
  if (bytes.length > MAX_RECORD_BYTES) {
    refuse(`mock-replay.mjs: the record is ${bytes.length} B; the cap is ${MAX_RECORD_BYTES} B`);
  }
  const text = bytes.toString('utf8');
  const sha256 = sha256FileBytes(bytes);

  // The map's caps are the run's caps unless a flag overrides them; an
  // override that disagrees with the map is refused in loadMap.
  let mapText;
  try {
    mapText = readFileSync(opts.map, 'utf8');
  } catch (error) {
    refuse(`mock-replay.mjs: cannot read map ${opts.map}: ${error.message}`);
  }
  let probe;
  try {
    probe = JSON.parse(mapText);
  } catch (error) {
    refuse(`mock-replay.mjs: map ${opts.map} is not JSON: ${error.message}`);
  }
  const textCap = opts.textCap ?? (Number.isInteger(probe?.textCap) ? probe.textCap : 4000);
  const maxReplies = opts.maxReplies ?? (Number.isInteger(probe?.maxReplies) ? probe.maxReplies : 24);
  const run = { sha256, textCap, maxReplies, textMode: opts.textMode };
  const { doc, sha256: mapSha } = loadReplayMap(mapText, opts.map, run);

  const { script, stats } = convertTranscript(text, {
    textCap,
    maxReplies,
    textMode: opts.textMode,
    sourceName: opts.record.split(/[\\/]/u).pop(),
  });
  if (script.replies.length === 0) {
    refuse(`mock-replay.mjs: no replayable turn in ${opts.record}`
      + ` (blocker ${String(stats.turns.blocker)})`);
  }
  // The map states the shape it was built from. A mismatch means the flags
  // changed what the converter emits, so the keys it maps may not be the keys
  // this run produces. `textCap` alone cannot change them (it only shortens
  // reply text); `maxReplies` can, so the counts are checked, not trusted.
  if (doc.turnCount !== undefined && doc.turnCount !== stats.turns.model_requests) {
    refuse(`mock-replay.mjs: map turnCount ${JSON.stringify(doc.turnCount)} != ${stats.turns.model_requests} in the record`);
  }
  if (doc.scriptedTurns !== undefined && doc.scriptedTurns !== stats.turns.mapped) {
    refuse(`mock-replay.mjs: map scriptedTurns ${JSON.stringify(doc.scriptedTurns)} != ${stats.turns.mapped} scripted; `
      + 'the cap or the record changed since the map was built');
  }

  const rewritten = rewriteScript(script, doc.pathMap);
  const serialized = `${canonicalScript(script)}\n`;

  let targets = { state: 'not-checked', missing: [], checked: 0 };
  if (opts.armRoot !== null) {
    if (!existsSync(opts.armRoot)) refuse(`mock-replay.mjs: --arm-root not found at ${opts.armRoot}`);
    const unique = new Set();
    for (const turn of rewritten.turns) for (const call of turn.calls) if (call.target !== null) unique.add(call.target);
    const missing = [...unique].filter((target) => !existsSync(join(opts.armRoot, target))).sort();
    targets = { state: missing.length === 0 ? 'all-present' : `${missing.length} missing`, missing, checked: unique.size };
  }
  // A mapped path that does not exist in the arm is the same silent failure as
  // an unmapped one: the tool errors, `tool_results_count` still advances, and
  // the script keeps matching. `--check` with an arm root therefore fails on it.
  const targetsFatal = opts.requireTargets || (opts.check && opts.armRoot !== null);

  const scriptLeaks = leakScan(serialized);
  const mapLeaks = leakScan(doc.pathMap === undefined ? '' : JSON.stringify(doc));
  const leaks = [...scriptLeaks, ...mapLeaks];

  const uniquePaths = new Set();
  const unmappedList = new Set();
  for (const turn of rewritten.turns) {
    for (const call of turn.calls) {
      if (call.path !== null) uniquePaths.add(call.path);
      if (call.path !== null && call.target === null) unmappedList.add(call.path);
    }
  }

  const summary = {
    mode: opts.check ? 'check' : 'convert',
    record: { name: opts.record.split(/[\\/]/u).pop(), bytes: bytes.length, sha256 },
    map: {
      name: opts.map.split(/[\\/]/u).pop(),
      sha256: mapSha,
      converterVersion: doc.converterVersion,
      textCap,
      maxReplies,
      entries: Object.keys(doc.pathMap).length,
      textMode: opts.textMode,
      unused: rewritten.unused,
    },
    turns: {
      model_requests: stats.turns.model_requests,
      completions: stats.turns.completions,
      scripted: stats.turns.mapped,
      dropped_after_blocker: stats.turns.dropped_after_blocker,
      truncated_by_max_replies: stats.turns.truncated_by_max_replies,
      blocker: stats.turns.blocker,
    },
    calls: {
      total: rewritten.totals.calls,
      tool_names: rewritten.toolNames,
      turns: rewritten.turns,
    },
    paths: {
      unique: uniquePaths.size,
      path_calls: rewritten.totals.path_calls,
      mapped: rewritten.totals.mapped,
      unmapped: rewritten.totals.unmapped,
      unmapped_list: [...unmappedList].sort(),
      pathless: rewritten.totals.pathless,
      by_tool: rewritten.totals.by_tool,
    },
    targets,
    leaks: { script: scriptLeaks.length, map: mapLeaks.length, hits: leaks },
    script: { replies: script.replies.length, sha256: sha256FileBytes(Buffer.from(serialized, 'utf8')), bytes: serialized.length },
    verdict: 'clean',
  };
  if (leaks.length > 0) summary.verdict = 'leak';
  else if (rewritten.totals.unmapped > 0) summary.verdict = 'unmapped';
  else if (targetsFatal && targets.missing.length > 0) summary.verdict = 'missing-targets';

  // A leaked script is never written: the refusal would exit 3 and leave the
  // file behind as if it were usable (ISSUE-581). The write is temp + rename
  // so a kill mid-write cannot leave a half script either.
  if (opts.out !== null && summary.verdict !== 'leak') {
    const temp = `${opts.out}.${String(process.pid)}.tmp`;
    writeFileSync(temp, serialized);
    renameSync(temp, opts.out);
  }

  if (opts.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else printHuman(summary);

  if (summary.verdict === 'leak') {
    for (const hit of leaks) process.stderr.write(`LEAK ${hit.kind}: ${hit.sample}\n`);
    process.exit(3);
  }
  if (summary.verdict === 'unmapped') process.exit(1);
  if (summary.verdict === 'missing-targets') process.exit(2);
  if (!opts.check) {
    process.stdout.write(`mock-replay.mjs: ${script.replies.length} replies`
      + `${opts.out === null ? ' (no --out; nothing written)' : ` -> ${opts.out}`}; `
      + `mock: ${MOCK}\n`);
  }
  process.exit(0);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();

