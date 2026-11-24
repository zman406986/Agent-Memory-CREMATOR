#!/usr/bin/env node
/**
 * Generate the leak-safe 110 bench briefs from the staging brief input
 * (dev/bench/swe-stage-leak-safe.mjs step 5).
 *
 * Usage:
 *   node dev/bench/swe-brief-leak-safe.mjs --input <brief-input.json> --out <md path>
 *     [--segments 6] [--combined]
 *
 * Owner directive 2026-11-18, corrected the same day (resume mechanics pinned
 * from bench-run.mjs source): the 110 items run as SIX sequential segments of
 * 20/20/20/20/20/10, one launch per segment resuming the same session.
 * DEFAULT = six files named from `--out` (`<stem>-seg1.md` … `<stem>-seg6.md`;
 * `--out dev/bench/bench-brief-leak-safe-110.md` gives
 * `bench-brief-leak-safe-110-seg1.md` … `-seg6.md`):
 *
 *   - seg1 is a FENCED BRIEF, the shape dev/bench/bench-run.mjs readBrief
 *     reads for a fresh launch: exactly ONE ```text block under a
 *     `## Task text` heading, the launcher trims and sha256s it, and the
 *     round manifest pins the hash. Its fence ends with the final line
 *     `BENCH-DONE`, and its in-fence deliverables list names the segment's
 *     own reports (20 paths, derivable by
 *     dev/bench/dsh-checkpoints.mjs deliverablesFromBrief).
 *   - seg2 … seg6 are RAW TASK FILES for `--task-file` on a `--resume`
 *     launch: read whole, no fence extraction — the proven shape of
 *     dev/bench/bench-brief-extended-36-followup.md. Task text with global
 *     numbering (`Task 21 of 110 - <instance_id>`), per-task report lines,
 *     the BENCH-DONE end-of-message instruction, and the file MUST END with
 *     the explicit deliverable list (the segment's new report paths, one per
 *     line; the last segment adds `swe-results/summary.md` before the list
 *     and to it), nothing after the last line.
 *
 * `--segments <n>` changes the count (capped at the task total; the fixed
 * 20/20/20/20/20/10 split applies only to the 6-over-110 campaign shape,
 * other shapes split evenly with the last segment shortest). `--combined`
 * writes ONE fenced brief at exactly `--out` carrying every task plus the
 * summary instruction — the single-brief generation, kept for the round
 * manifest gate and any whole-run reading.
 *
 * Numbering is GLOBAL in every file: `Task 21 of 110 - <instance_id>`, N
 * always the full task total. Per task: the verbatim problem_statement (any
 * triple-backtick line re-indented four spaces so the seg1 fence cannot
 * break), `Repo path: swe/<instance_id>/`, the FAIL_TO_PASS ids verbatim,
 * `P2P tests: <count> named in the pack (do not chase them; do not weaken
 * them)`, the venv python absolute path, one Bash and one PowerShell form
 * running pytest on the F2P ids, and the report line.
 *
 * `--quarantine <quarantine.json>` (dev/bench/swe-preflight.mjs output; the
 * preflight.json shape works too): the named tasks are dropped from ALL
 * segment files BEFORE slicing, the rest is renumbered globally (N = the
 * remaining count), and a ONE-LINE comment stating the exclusion count sits
 * OUTSIDE the task fence in every file — never inside it. Segments stay
 * 20/20/20/20/20/rest (segmentBounds).
 *
 * The files NEVER contain test_patch, gold_patch or any PASS_TO_PASS id list
 * — the pack carries those and swe-score.mjs applies them after the run.
 * Outside the seg1 fence the text names no arm, no token grant, no clock, no
 * window and no product repo; paths are arm-relative (`swe/<id>/`,
 * `swe-results/`), because the tested agent's working directory is the arm.
 *
 * PROTOCOL block (2026-11-18 smoke diagnosis: the agent skipped reports and
 * sprinted breadth-first): inside the seg1 fence at the top and at the top of
 * every seg2-6 task file, before the first task block — strict order, one
 * task at a time, a task complete only when its report file EXISTS, the
 * BLOCKED path, never a task without its report (protocolBlock).
 *
 * Plain Node >= 22, no dependencies. Exit 0 = files written; 2 = bad
 * arguments or an input that cannot produce the files.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';
import { segmentBounds } from './swe-stage-leak-safe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

const BRIEF_OPTIONS = optionsOf([
  ['--input', 'string'],
  ['--out', 'string'],
  ['--segments', 'string'],
  ['--quarantine', 'string'],
  ['--combined', 'boolean'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: BRIEF_OPTIONS,
    refuse: fail,
    help: 'usage: swe-brief-leak-safe.mjs --input <brief-input.json> --out <md path>\n'
      + '  [--segments 6] [--combined]\n'
      + 'default: <stem>-seg1.md (fenced brief) and -seg2..seg<n> (raw --task-file files) beside --out;\n'
      + '--combined writes one fenced brief at --out with every task\n',
  });
  for (const [key, flag] of [['input', '--input'], ['out', '--out']]) {
    if (values[key] === undefined) fail(`swe-brief-leak-safe.mjs: ${flag} <path> is required`);
  }
  if (values.segments !== undefined && values.combined === true) {
    fail('swe-brief-leak-safe.mjs: --combined and --segments cannot be combined');
  }
  return {
    input: resolve(values.input),
    out: resolve(values.out),
    segments: values.segments === undefined ? null : Number.parseInt(values.segments, 10),
    quarantine: values.quarantine === undefined ? null : resolve(values.quarantine),
    combined: values.combined ?? false,
  };
}

/**
 * The quarantined instance_ids from dev/bench/swe-preflight.mjs output: a
 * bare JSON array of ids, or its preflight.json shape (an object whose
 * `quarantine` array holds the ids). Entries that are objects read their
 * `instance_id`.
 */
export function normalizeQuarantine(doc) {
  const raw = Array.isArray(doc) ? doc : (Array.isArray(doc?.quarantine) ? doc.quarantine : null);
  if (raw === null) {
    throw new Error('the quarantine file is neither an id array nor a preflight.json shape '
      + '(an object with a quarantine array)');
  }
  const ids = [];
  for (const entry of raw) {
    const id = typeof entry === 'string' ? entry : String(entry?.instance_id ?? '');
    if (id !== '' && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The one-line exclusion comment, outside every task fence. */
export function quarantineNote(excludedCount, remaining) {
  if (!(excludedCount > 0)) return null;
  return `<!-- leak-safe quarantine: ${String(excludedCount)} task(s) excluded from the pack `
    + `before slicing; task numbering renumbered over the remaining ${String(remaining)} -->`;
}

/**
 * Drop the quarantined ids from the entries and renumber the rest globally
 * (order = position + 1; N becomes the remaining count). Ids absent from the
 * pack are ignored (the stager may have discarded them already).
 */
export function applyQuarantine(entries, ids) {
  const excluded = new Set(ids.filter((id) => entries.some((entry) => entry.instance_id === id)));
  const dropped = entries.filter((entry) => excluded.has(entry.instance_id));
  const remaining = entries
    .filter((entry) => !excluded.has(entry.instance_id))
    .map((entry, index) => ({ ...entry, order: index + 1 }));
  return { remaining, dropped, excludedCount: excluded.size };
}

/** The issue text with every triple-backtick line indented four spaces. */
export function fenceSafe(text) {
  return String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => (line.trimStart().startsWith('```') ? `    ${line}` : line))
    .join('\n');
}

/** `true` when the text still carries a line that would open or close a fence. */
export function carriesFence(text) {
  return String(text ?? '').split(/\r?\n/u).some((line) => line.startsWith('```'));
}

/** The pytest command tail shared by both shells. */
function pytestArgs(targets) {
  return ['-m', 'pytest', ...targets, '-q', '--no-header', '-p', 'no:cacheprovider'];
}

/**
 * One task's block, shared by the fenced brief and the raw task files.
 * `entry` is one brief-input.json row; `total` is the FULL task count
 * (numbering is global). The F2P ids are printed verbatim; the commands run
 * the intact ids only (an id truncated at selection cannot run and is graded
 * as dropped by the scorer).
 */
export function taskBlock(entry, total) {
  const problems = [];
  for (const [key, flag] of [
    ['instance_id', 'instance_id'], ['repoPath', 'repoPath'], ['problemStatement', 'problemStatement'],
    ['f2p', 'f2p'], ['p2pCount', 'p2pCount'], ['venvPython', 'venvPython'],
  ]) {
    if (entry[key] === undefined || entry[key] === null) problems.push(flag);
  }
  if (problems.length > 0) {
    fail(`swe-brief-leak-safe.mjs: ${entry.instance_id ?? '?'} is missing ${problems.join(', ')} (re-run the staging step)`);
  }
  const number = entry.order;
  const targets = Array.isArray(entry.pytestTargets) && entry.pytestTargets.length > 0
    ? entry.pytestTargets
    : (Array.isArray(entry.f2p) ? entry.f2p : []);
  const truncated = Number(entry.truncatedF2P ?? 0);
  const pythonPath = entry.pythonPath ?? '.';
  const layout = pythonPath === 'src'
    ? `the package sits under ${entry.repoPath}/src/, so the PYTHONPATH value is src`
    : `${entry.repoPath}/ is flat (the package sits directly in it), so the PYTHONPATH value is a single dot`;
  const args = pytestArgs(targets);
  return [
    `Task ${String(number)} of ${String(total)} - ${entry.instance_id}`,
    '',
    fenceSafe(entry.problemStatement),
    '',
    `Repo path: ${entry.repoPath}/`,
    '',
    `FAIL_TO_PASS test ids that must pass after your fix: ${(entry.f2p ?? []).join('; ')}`,
    `P2P tests: ${String(entry.p2pCount)} named in the pack (do not chase them; do not weaken them)`,
    '',
    'How to run Python for this task.',
    'Interpreter, exactly this absolute path:',
    `    ${entry.venvPython}`,
    `Run pytest with the repo dir as cwd and PYTHONPATH set. Form stated for this task: ${layout}.`,
    'Bash (Git Bash) form:',
    `    cd ${entry.repoPath} && PYTHONPATH=${pythonPath} "${entry.venvPython}" ${args.join(' ')}`,
    'PowerShell form:',
    `    Set-Location ${entry.repoPath}; $env:PYTHONPATH='${pythonPath}'; & "${entry.venvPython}" ${args.join(' ')}`,
    truncated > 0
      ? `${String(truncated)} of the FAIL_TO_PASS ids above are truncated in the dataset and are left out of the commands; the harness grades the intact ids.`
      : 'Targets above are the FAIL_TO_PASS ids; run them exactly as written.',
    '',
    `Write the one report for this task, swe-results/${entry.instance_id}.md`,
    '',
    '----------------------------------------------------------------------',
    '',
  ].join('\n');
}

/**
 * The depth-first protocol, INSIDE the task fence at the top of the seg1
 * brief and at the top of every raw seg2-6 task file, before the first task
 * block. Every binding element is kept: strict order, one task at a time,
 * complete only when the report file EXISTS, the BLOCKED path, and never a
 * task without its report. `last` files (the last segment, --combined) name
 * the summary report; earlier files must not (the summary is seg6's
 * deliverable alone).
 */
export function protocolBlock(last) {
  const finish = last
    ? '(5) After the last task, write swe-results/summary.md and end your final message with BENCH-DONE.'
    : '(5) The final part of this session writes the summary report and ends with BENCH-DONE; this part is done only when the last task below has its report.';
  return [
    'PROTOCOL for every task below:',
    '(1) Work strictly in the order given; do not skip ahead or jump back.',
    '(2) One task at a time: read the issue in the task\'s repo, fix the code, then run that',
    '    task\'s F2P tests with the venv python command given in the task block.',
    '(3) Finish before moving on: a task is complete only when its report file',
    '    swe-results/<instance_id>.md EXISTS. Write it immediately after you run the tests,',
    '    before you touch the next task. The report states: what you changed (files and why),',
    '    the exact test command you ran, and the F2P outcome (which tests passed or failed, and the counts).',
    '(4) If you cannot make the F2P tests pass after a real attempt, STOP that task, write the',
    '    report with status BLOCKED and the reason (what you tried, what still fails), and move',
    '    to the next task. Never leave a task without its report.',
    finish,
    '',
  ].join('\n');
}

/** The hard-rule reminder shared by every file, fenced or raw. */
function hardRules() {
  return [
    'HARD RULES:',
    '- No network access of any kind: no curl, no git clone, no git fetch, no git pull,',
    '  no pip install, no downloads. Every package you need is already installed in the',
    '  interpreter named above.',
    '- Do not read or write anything outside this workspace.',
    '- The workspace is sandboxed: a command that names any path outside it, except the',
    '  interpreter named in each task block, is refused by the shell before it runs.',
    '  Do not run git; the workspace has no git history.',
    '- Do not create or modify test files. The tests are the grader; changing them',
    '  changes nothing and is read as cheating.',
    '- Do not edit files under swe-results/ except writing your own report files named below.',
    '- Keep your changes inside the task\'s own directory. Do not patch a file outside',
    '  swe/<instance_id>/ and do not touch another task\'s directory.',
    '- If a task turns out to be impossible, say so in its report and move on. Never',
    '  block the whole run on one task.',
    '',
  ].join('\n');
}

/** The report-form prose shared by every file, fenced or raw. */
function reportProse() {
  return [
    'REPORTS. After finishing (or giving up on) each task, write',
    'swe-results/<instance_id>.md with four sections: what the bug was; what you',
    'changed (files and why); how you verified (the commands you ran and their',
    'outcomes); your confidence.',
    '',
  ].join('\n');
}

/**
 * The FENCED brief for a fresh launch (seg1, or every task with --combined).
 * Pure: entries (global `order` values) plus the plan in, brief text out —
 * the test builds one and checks the fence, the deliverable derivation and
 * the P2P absence. `plan` = { first, last, start, end, total }.
 */
export function buildSegmentBrief(entries, plan) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail('swe-brief-leak-safe.mjs: a segment holds no tasks');
  }
  const { first, last, start, end, total, quarantineNote: note } = plan;
  entries.forEach((entry, index) => {
    if (entry.order !== start + index) {
      fail(`swe-brief-leak-safe.mjs: ${entry.instance_id ?? '?'} carries order ${String(entry.order)}, `
        + `expected ${String(start + index)}; the segment slice must be contiguous and in brief order`);
    }
  });

  const opener = first
    ? [
        'You are a senior engineer working offline in this workspace. The workspace holds',
        `${String(total)} independent bug-fix tasks, one per directory under swe/<instance_id>/.`,
        'Each directory is a full copy of an open-source Python project at the commit just',
        'before one bug was fixed. Fix each bug at its source. Work through the tasks in',
        `the order given below and keep going until all ${String(total)} are done.`,
        `This launch starts the work: tasks ${String(start)} to ${String(end)} of ${String(total)} are listed below.`,
        '',
      ]
    : [];

  const summarySection = last
    ? [
        'Write swe-results/summary.md',
        '',
        `The summary lists all ${String(total)} tasks with one line of outcome each.`,
        '',
      ]
    : [
        `A later part of this session names the remaining tasks; write every report at`,
        'swe-results/<instance_id>.md as you finish each one.',
        '',
      ];

  const closing = [
    hardRules(),
    reportProse(),
    ...summarySection,
    'When every report file named below exists, print exactly one line as the',
    'last line of your final message. Do not stop before it, and add nothing',
    'after it.',
    '',
    'The deliverables are, by exact path:',
    ...entries.map((entry) => `swe-results/${entry.instance_id}.md`),
    ...(last ? ['swe-results/summary.md'] : []),
    'BENCH-DONE',
    '',
  ].join('\n');

  // The protocol sits INSIDE the fence, after the role opener and before
  // Task 1's block.
  const body = opener.join('\n')
    + protocolBlock(last)
    + entries.map((entry) => taskBlock(entry, total)).join('\n')
    + closing;
  if (carriesFence(body)) {
    fail('swe-brief-leak-safe.mjs: the task block still carries a fence line; '
      + 're-run the staging step (its fenceSafe must indent every ``` line)');
  }

  const lineage = entries.map((entry) => `  - ${entry.instance_id}: ${entry.issueTextSourceSha256 ?? '(unhashed)'}`);
  const range = `tasks ${String(start)} to ${String(end)} of ${String(total)}`;
  const title = first && last ? `all ${String(total)} tasks` : range;
  const brief = [
    `# Bench brief - leak-safe: ${title}`,
    ...(note === null ? [] : ['', note]),
    '',
    'This file holds the exact task text the launcher hands the agent. The launcher',
    'reads the first fenced block under *Task text* and sha256s it, so nothing',
    'outside that block reaches the agent and any edit inside it is a new task.',
    'The block is the only fence in this file.',
    '',
    `The workspace holds ${String(total)} independent bug-fix tasks under`,
    '`swe/<instance_id>/`; this launch lists ' + range + '. Each task names its own',
    'interpreter by absolute path inside the task list. On the other device the same',
    'tree lives with `C:\\Users\\TZ\\` in place of `C:\\Users\\TZhen\\`.',
    '',
    '## Task text',
    '',
    '```text',
    body,
    '```',
    '',
    '## Brief notes',
    '',
    '- Task text above is verbatim from the dataset rows: each problem statement',
    '  was copied unchanged, and its triple-backtick lines were re-indented four',
    '  spaces by the staging step, so the text carries no fence of its own.',
    '- Source lineage, issueTextSourceSha256 per task:',
    ...lineage,
    '',
  ].join('\n');
  return { brief, body };
}

/**
 * The RAW task file for a `--resume --task-file` launch (seg2 … seg6), the
 * proven shape of dev/bench/bench-brief-extended-36-followup.md: read whole,
 * no fence extraction, and the file MUST END with the explicit deliverable
 * list — nothing after the last path line.
 */
export function buildFollowupTaskFile(entries, plan) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail('swe-brief-leak-safe.mjs: a segment holds no tasks');
  }
  const { segmentNumber, segmentCount, last, start, end, total, quarantineNote: note } = plan;
  entries.forEach((entry, index) => {
    if (entry.order !== start + index) {
      fail(`swe-brief-leak-safe.mjs: ${entry.instance_id ?? '?'} carries order ${String(entry.order)}, `
        + `expected ${String(start + index)}; the segment slice must be contiguous and in brief order`);
    }
  });

  const summarySection = last
    ? [
        `Then write swe-results/summary.md: all ${String(total)} tasks, one line of outcome each.`,
        '',
      ]
    : [];

  const text = [
    `Follow-up task - leak-safe segment ${String(segmentNumber)} of ${String(segmentCount)}`,
    ...(note === null ? [] : [note, '']),
    'You are continuing the same engineering session. The tasks already listed are',
    'done or reported; do not redo them. The workspace holds the',
    `${String(total)} bug-fix directories under swe/<instance_id>/; this part lists`,
    `tasks ${String(start)} to ${String(end)} of ${String(total)}. Fix each bug at its source. Work through`,
    'the tasks in the order given below and keep going until every task of the whole',
    `${String(total)} is done. The same hard rules hold as at the start: no network access, no`,
    'test-file edits, changes inside the task\'s own directory only. Every task names',
    'its own interpreter by absolute path; on the other device C:\\Users\\TZ\\ replaces',
    'C:\\Users\\TZhen\\ in every path this file names.',
    '',
    // The protocol opens the raw task file too, before the first task block.
    protocolBlock(last),
    ...entries.map((entry) => taskBlock(entry, total)),
    summarySection,
    'When the last report file named below exists, print exactly one line:',
    '',
    'BENCH-DONE',
    '',
    'as the last line of an assistant message that also states, in at most three',
    'sentences, what you produced. After that line, stop: no further message, no',
    'further edit, no further read.',
    '',
    'The deliverables are, by exact path:',
    ...entries.map((entry) => `swe-results/${entry.instance_id}.md`),
    ...(last ? ['swe-results/summary.md'] : []),
  ].flat().join('\n') + '\n';
  return { text, body: text };
}

/** The deliverable paths a segment names: its reports (+ the summary, last only). */
export function segmentDeliverables(entries, last) {
  return [
    ...entries.map((entry) => `swe-results/${entry.instance_id}.md`),
    ...(last ? ['swe-results/summary.md'] : []),
  ];
}

function main(argv) {
  const opts = parseArgs(argv);
  let entries;
  try {
    entries = JSON.parse(readFileSync(opts.input, 'utf8'));
  } catch (error) {
    fail(`swe-brief-leak-safe.mjs: cannot read ${opts.input}: ${error.message}`);
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`swe-brief-leak-safe.mjs: ${opts.input} holds no task entries`);
  }
  entries.forEach((entry, index) => {
    if (entry.order !== index + 1) {
      fail(`swe-brief-leak-safe.mjs: ${entry.instance_id ?? '?'} carries order ${String(entry.order)}; `
        + 'the input must be in brief order (position + 1)');
    }
  });

  // Quarantine (dev/bench/swe-preflight.mjs output): drop the named tasks
  // from ALL segment files BEFORE slicing, renumber globally over what
  // remains. The count goes into a one-line comment outside every task fence.
  let quarantineNoteText = null;
  if (opts.quarantine !== null) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(opts.quarantine, 'utf8'));
    } catch (error) {
      fail(`swe-brief-leak-safe.mjs: cannot read ${opts.quarantine}: ${error.message}`);
    }
    let ids;
    try {
      ids = normalizeQuarantine(doc);
    } catch (error) {
      fail(`swe-brief-leak-safe.mjs: ${error.message}`);
    }
    const absent = ids.filter((id) => !entries.some((entry) => entry.instance_id === id));
    if (absent.length > 0) {
      say(`quarantine: ${String(absent.length)} id(s) not in the pack (already discarded by the stager?): ${absent.join(', ')}`);
    }
    const applied = applyQuarantine(entries, ids);
    entries = applied.remaining;
    if (entries.length === 0) fail('swe-brief-leak-safe.mjs: every task is quarantined; nothing to emit');
    quarantineNoteText = quarantineNote(applied.excludedCount, entries.length);
    say(`quarantine: dropped ${String(applied.excludedCount)} task(s)${applied.dropped.length > 0 ? `: ${applied.dropped.map((entry) => entry.instance_id).join(', ')}` : ''}`
      + `; ${String(entries.length)} remain, renumbered 1-${String(entries.length)}`);
  }

  const total = entries.length;
  const stem = opts.out.replace(/\.md$/iu, '');
  const ext = opts.out.slice(stem.length);
  const written = [];

  if (opts.combined || opts.segments === 1) {
    const bounds = segmentBounds(total, 1);
    const { brief, body } = buildSegmentBrief(entries, {
      first: true, last: true, start: bounds[0].start, end: bounds[0].end, total,
      quarantineNote: quarantineNoteText,
    });
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, brief, 'utf8');
    written.push({ path: opts.out, entries, body, fenced: true, last: true });
    say(`brief: ${opts.out} (combined: tasks 1-${String(total)} of ${String(total)}, `
      + `block ${String(body.length)} chars, deliverables ${String(total + 1)})`);
  } else {
    const segments = opts.segments === null ? 6 : opts.segments;
    if (!Number.isInteger(segments) || segments <= 0) fail('swe-brief-leak-safe.mjs: --segments must be a positive integer');
    const bounds = segmentBounds(total, segments);
    for (const [index, bound] of bounds.entries()) {
      const slice = entries.slice(bound.start - 1, bound.end);
      const last = index === bounds.length - 1;
      const file = `${stem}-seg${String(index + 1)}${ext}`;
      mkdirSync(dirname(file), { recursive: true });
      if (index === 0) {
        const { brief, body } = buildSegmentBrief(slice, {
          first: true, last, start: bound.start, end: bound.end, total,
          quarantineNote: quarantineNoteText,
        });
        writeFileSync(file, brief, 'utf8');
        written.push({ path: file, entries: slice, body, fenced: true, last });
        say(`brief: ${file} (fenced brief, ${rangeLabel(bound)} of ${String(total)}, `
          + `block ${String(body.length)} chars, deliverables ${String(segmentDeliverables(slice, last).length)})`);
      } else {
        const { text } = buildFollowupTaskFile(slice, {
          segmentNumber: index + 1, segmentCount: bounds.length,
          last, start: bound.start, end: bound.end, total,
          quarantineNote: quarantineNoteText,
        });
        writeFileSync(file, text, 'utf8');
        written.push({ path: file, entries: slice, body: text, fenced: false, last });
        say(`task file: ${file} (--task-file, ${rangeLabel(bound)} of ${String(total)}, `
          + `deliverables ${String(segmentDeliverables(slice, last).length)})`);
      }
    }
  }

  for (const { body, fenced } of written) {
    if (fenced && carriesFence(body)) fail('swe-brief-leak-safe.mjs: an emitted fenced block carries a fence line');
  }
  say(`task total: ${String(total)}`);
}

function rangeLabel(bound) {
  return bound.start === bound.end
    ? `task ${String(bound.start)}`
    : `tasks ${String(bound.start)}-${String(bound.end)}`;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) main(process.argv.slice(2));
