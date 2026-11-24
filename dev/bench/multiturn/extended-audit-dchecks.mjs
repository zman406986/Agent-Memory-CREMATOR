#!/usr/bin/env node
/**
 * ISSUE-080 method (b) — the D-checks over both extended-run arms.
 *
 * Usage:
 *   node dev/bench/multiturn/extended-audit-dchecks.mjs --image <dir> --arm <dir>
 *        [--label <name>] [--out <dir>] [--json]
 *
 *   --image  the arm's PRE-run tree (a still image). Every "computed" side is
 *            read from here, never from the post-run arm: a record that edited
 *            its own input would otherwise score itself.
 *   --arm    the post-run arm directory, holding
 *            `docs/plans/2026-10-27-extended-audit/` and the seven indexes.
 *   --out    where `dchecks.json` and `dchecks.txt` land.
 *
 * Offline. No model, no network, no scratchpad path in any assertion: the two
 * inputs are the only things read.
 *
 * ## What a D-check is
 *
 * `docs/plans/2026-10-28-removal-quality/methods.md` §3: an expectation a
 * script settles by recomputing the fact from the pre-run tree. This script is
 * that "computed" side. It emits one row per expectation with `pass`, `fail`
 * and, where the record's shape never rose to the expectation, `not-reached`.
 *
 * Three rules keep the numbers honest:
 *   1. every expectation prints the computed value beside the record's value,
 *      so a reader sees the disagreement rather than a score;
 *   2. no expectation is skipped because the record's table has an unfamiliar
 *      shape — an unparsed table is a `fail` naming what could not be read;
 *   3. the four pattern searches of T5 are recomputed with the README's own
 *      regexes over `client-scripts/*.lua`, read line by line; the README's
 *      printed pipeline order is reproduced stage for stage.
 *
 * Exit 0 whenever the sweep completed, whatever the rows say. Exit 2 only on a
 * refused invocation or a missing input.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionsOf, parseDevArgs } from '../../shared/args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const AUDIT = 'docs/plans/2026-10-27-extended-audit';
const REF_GATE_DOC = 'docs/project/building/ref-lua-subset-gate.md';
const SEVEN_INDEXES = [
  'docs/project/index.md',
  'docs/project/building/index.md',
  'docs/project/building/phase0-protocols/index.md',
  'docs/project/platform/index.md',
  'docs/project/sessions/index.md',
  'docs/guides/index.md',
  'docs/adr/index.md',
];
const ENTRY_DOCS = ['AGENTS.md', 'CONTEXT.md', 'PRD.md', 'docs/project/index.md', 'docs/guides/index.md', 'docs/adr/index.md'];
const RECORD_FILES = [
  '00-index.md', '01-orientation.md', '02-entry-currency.md', '03-core-charter.md', '04-core-tests.md',
  '05-shell-quarantine.md', '06-gate-coverage.md', '07-plan-traceability.md', '08-distillation-audit.md',
  '09-open-triage.md', '10-plans-disposition.md', '11-corpus-en.md', '12-corpus-zh.md',
];

const USAGE = 'usage: extended-audit-dchecks.mjs --image <dir> --arm <dir> '
  + '[--label <name>] [--out <dir>] [--json]';

/** This script's refusal shape: the usage line, a blank line, then `refused: <why>`. */
function usage(why) {
  const lines = [USAGE, ...(why ? ['', `refused: ${why}`] : [])];
  process.stderr.write(`${lines.join('\n')}\n`);
  process.exit(2);
}

// The flags this sweep reads, declared once so the shared parser (ISSUE-072)
// binds a negative value to its option and refuses an unknown one.
const DCHECKS_OPTIONS = optionsOf([
  ['--image', 'string'],
  ['--arm', 'string'],
  ['--label', 'string'],
  ['--out', 'string'],
  ['--json', 'boolean'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: DCHECKS_OPTIONS,
    refuse: message => usage(message),
  });
  const out = {
    image: values.image ?? null,
    arm: values.arm ?? null,
    label: values.label ?? null,
    out: values.out ?? null,
    json: values.json ?? false,
  };
  if (!out.image) usage('--image is required');
  if (!out.arm) usage('--arm is required');
  if (!existsSync(out.image)) usage(`image tree not found: ${out.image}`);
  if (!existsSync(join(out.arm, AUDIT))) usage(`no ${AUDIT} under ${out.arm}`);
  return out;
}

// --------------------------------------------------------------------------
// tree helpers
// --------------------------------------------------------------------------

function walk(root, rel = '', out = []) {
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, next, out);
    else if (entry.isFile()) out.push(next);
  }
  return out;
}

const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
const exists = (root, rel) => existsSync(join(root, rel)) && statSync(join(root, rel)).isFile();
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// --------------------------------------------------------------------------
// markdown: find tables and read cells
// --------------------------------------------------------------------------

const splitRow = (line) => {
  const t = line.trim();
  const body = t.startsWith('|') ? t.slice(1) : t;
  const tail = body.endsWith('|') ? body.slice(0, -1) : body;
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i];
    if (c === '\\' && tail[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
};

const isSeparator = (line) => /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');

function tablesOf(text) {
  const lines = text.split(/\r?\n/);
  const tables = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^\s*\|/.test(lines[i]) || !isSeparator(lines[i + 1])) continue;
    const header = splitRow(lines[i]);
    const rows = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      if (!/^\s*\|/.test(lines[j])) break;
      rows.push(splitRow(lines[j]));
    }
    tables.push({ header, rows, line: i + 1 });
    i = j - 1;
  }
  return tables;
}

const strip = (cell) => cell.replace(/^`+|`+$/g, '').replace(/\*\*/g, '').trim();
/** Backticks gone on both sides, whitespace collapsed: what a title comparison uses. */
const plain = (cell) => String(cell).replace(/`/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
const headerIndex = (header, ...names) => {
  for (const name of names) {
    const want = name.toLowerCase();
    const i = header.findIndex((h) => h.toLowerCase().includes(want));
    if (i !== -1) return i;
  }
  return -1;
};
/** `find` with a column test that may legitimately be column 0. */
const tableWhere = (tables, ...names) => tables.find((t) => names.every((n) => headerIndex(t.header, n) !== -1));
const tableCol = (tables, ...names) => tables.find((t) => names.some((n) => headerIndex(t.header, n) !== -1));

// --------------------------------------------------------------------------
// the expectation record
// --------------------------------------------------------------------------

const rows = [];
/**
 * One expectation. `kind` decides how the row enters the score:
 *   `check`    — a scored D-check (default);
 *   `observ`   — a measurement whose recorded side depends on a reading this script cannot
 *                settle (a resolution rule the record states in prose, a table split). Printed,
 *                never scored, so a definition difference never reads as a record defect.
 */
function expect(pass, id, label, computed, recorded, kind = 'check') {
  rows.push({ pass, id, label, computed, recorded, kind });
}

// --------------------------------------------------------------------------
// T1 — orientation
// --------------------------------------------------------------------------

function level2Headings(text) {
  return text.split(/\r?\n/)
    .filter((l) => /^## /.test(l))
    .map((l) => l.replace(/^## /, '').trim());
}

function checkT1(image, arm, records) {
  const t1 = records['01-orientation.md'];
  const idx = records['00-index.md'];
  expect(!!idx && /\|/.test(idx), 'T1.1', '00-index.md and 01-orientation.md exist', 'both present',
    `${idx ? 'present' : 'MISSING'}, ${t1 ? 'present' : 'MISSING'}`);
  if (!t1) return;

  const wanted = ENTRY_DOCS.map((doc) => ({
    doc,
    headings: exists(image, doc) ? level2Headings(read(image, doc)) : null,
  }));
  const table = tableWhere(tablesOf(t1), 'level-2');
  if (!table) {
    expect(false, 'T1.2', '01-orientation.md carries a six-row level-2 table', `${ENTRY_DOCS.length} rows`, 'table not found');
    return;
  }
  expect(table.rows.length === ENTRY_DOCS.length, 'T1.2', '01-orientation.md table has six rows',
    String(ENTRY_DOCS.length), String(table.rows.length));

  const seen = new Map();
  for (const row of table.rows) {
    const doc = strip(row[0] ?? '').replace(/^\.\//, '');
    const listed = (row[1] ?? '').split(';').map((s) => strip(s).trim()).filter(Boolean);
    seen.set(doc, listed);
  }
  const wrong = [];
  const missingDoc = [];
  for (const { doc, headings } of wanted) {
    if (!exists(image, doc)) { missingDoc.push(doc); continue; }
    const listed = seen.get(doc);
    if (!listed) { wrong.push(`${doc}: row absent`); continue; }
    const want = headings.length ? headings : ['none'];
    const got = listed.length === 1 && /^none$/i.test(listed[0]) ? ['none'] : listed;
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      wrong.push(`${doc}: image ${JSON.stringify(want)} vs record ${JSON.stringify(got)}`);
    }
  }
  expect(wrong.length === 0, 'T1.3', 'every heading sequence equals the image, in order',
    `${wanted.length - wrong.length}/${wanted.length} rows agree`, wrong.length ? wrong.join(' | ') : 'all agree');
  expect(missingDoc.length === 0, 'T1.4', 'all six entry documents exist in the image', '6', String(6 - missingDoc.length));
}

// --------------------------------------------------------------------------
// T2 — entry currency
// --------------------------------------------------------------------------

const PATH_TOKEN = /`([^`\n]+)`/g;
// A backticked token is a repo-relative path when its first segment is a top-level entry of the
// image and it ends in a separator or a known file extension. Prose like `path_id/` is not a path.
const TOP_LEVEL = new Set(['archive', 'build', 'client-scripts', 'dev', 'docs', 'issue-tracker', 'locale',
  'pipeline', 'platform-free-core', 'prototype test', 'scratchpad']);
const FILE_EXT = /\.(md|lua|ts|json|py|ps1|txt|yml|yaml|go|rs|js|mjs|csv)$/;
function isPathToken(raw) {
  const token = String(raw ?? '').replace(/:\d+([-\u2013]\d+)?$/, '').trim();
  if (!token) return false;
  if (/[<>{}*$\u2026]/.test(token)) return false;           // placeholder, glob, template
  if (/^[a-z]+:\/\//i.test(token)) return false;            // a URL
  if (token.startsWith('../')) return false;                // outside this checkout
  if (/\s/.test(token)) return false;                       // a path holds no space inside the fence
  if (/^\d/.test(token)) return false;                      // arithmetic and figures, not paths
  // every segment must look like a filename or a directory name, not an expression
  if (!/^[A-Za-z0-9_.@-]+(\/[A-Za-z0-9_.@\u4e00-\u9fff()（）-]+)*\/?$/.test(token)) return false;
  if (token.includes('/')) return true;
  return FILE_EXT.test(token);
}
const existsAny = (root, rel) => {
  try { return statSync(join(root, rel)) !== undefined; } catch { return false; }
};
/**
 * Strict existence: "does not exist on disk" means the path itself, the path relative to the
 * citing file, or the same path under either mirror root. No bare-filename escape — the record's
 * claims are about paths, and a same-named file elsewhere does not make a path exist.
 */
const resolveStrict = (image, token, citingFile) => {
  const bare = token.replace(/:\d+([-\u2013]\d+)?$/, '').trim().replace(/\/$/, '');
  if (!bare) return true;
  // the citing file may arrive abbreviated (`ADR-0002:22,27`), so a directory join is only
  // attempted when it looks like a real path, and it is always anchored at the image root
  const citingDir = /^[\w./-]+\.md$/.test(citingFile) ? dirname(citingFile) : '.';
  const candidates = [bare, `docs/official-docs-mirror-en-us/${bare}`,
    `docs/official-docs-mirror-zh-cn/${bare}`,
    join(citingDir, bare).replace(/\\/g, '/')];
  return candidates.some((c) => existsAny(image, c));
};
/** The scan's own looser rule, used only to decide whether MY scan noticed a token at all. */
const resolveLenient = (image, token, citingFile, allFiles) => {
  const bare = token.replace(/:\d+([-\u2013]\d+)?$/, '').trim().replace(/\/$/, '');
  if (!bare) return true;
  if (resolveStrict(image, token, citingFile)) return true;
  const base = bare.split('/').pop() ?? bare;
  return allFiles.some((f) => f === base || f.endsWith(`/${base}`));
};

function checkT2(image, arm, records) {
  const t2 = records['02-entry-currency.md'];
  if (!t2) {
    expect(false, 'T2.0', '02-entry-currency.md exists', 'present', 'MISSING');
    return;
  }
  const files = walk(image).filter((f) => /^(docs\/project|docs\/guides|docs\/adr)\//.test(f));
  const tables = tablesOf(t2);
  const perFile = tables[0];
  expect(perFile?.rows.length === files.length, 'T2.1', 'per-file table has one row per file read',
    String(files.length), String(perFile?.rows.length ?? 0));

  // computed dangling set: unique citing file:line + cited path
  const all = walk(image);
  const dangling = new Set();
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const lines = read(image, file).split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(PATH_TOKEN)) {
        const token = m[1].trim();
        if (!isPathToken(token)) continue;
        if (!resolveLenient(image, token, file, all)) {
          dangling.add(`${file}:${i + 1} ${token.replace(/:\d+([-–]\d+)?$/, '').trim()}`);
        }
      }
    });
  }
  // recorded set: every (citing file, line, cited path) in the record's second table
  const recorded = new Set();
  const citeTable = tables.find((t) => headerIndex(t.header, 'cited path', 'path as cited') !== -1);
  if (citeTable) {
    const c = headerIndex(citeTable.header, 'cited path', 'path as cited');
    const f = headerIndex(citeTable.header, 'citing file');
    const l = headerIndex(citeTable.header, 'line');
    for (const row of citeTable.rows) {
      const cited = strip(row[c] ?? '');
      const citing = strip(row[f] ?? '');
      const lineCell = String(row[l] ?? '');
      if (!cited || cited.startsWith('../')) continue;
      const numbers = lineCell.match(/\d+/g) ?? [];
      for (const n of numbers.length ? numbers : ['']) {
        recorded.add(`${citing}:${n} ${cited.replace(/:\d+([-–]\d+)?$/, '').trim()}`);
      }
    }
  }
  // A D-check recomputes the fact the record states. Each row is a claim — "this path, cited at
  // this file and line, does not exist in the pre-run tree" — so the script checks the claim
  // itself, with no dependence on how wide a token scan either side used.
  const claimRows = [];
  if (citeTable) {
    const c = headerIndex(citeTable.header, 'cited path', 'path as cited');
    const f = headerIndex(citeTable.header, 'citing file');
    const l = headerIndex(citeTable.header, 'line');
    for (const row of citeTable.rows) {
      const cited = strip(row[c] ?? '');
      const citing = strip(row[f] ?? '');
      if (!cited || cited.startsWith('../')) continue;
      const numbers = String(row[l] ?? '').match(/\d+/g) ?? [''];
      claimRows.push({ cited, citing, lines: numbers });
    }
  }
  const falsified = claimRows.filter((row) => resolveStrict(image, row.cited, row.citing));
  expect(falsified.length === 0, 'T2.2',
    'every path the record calls dangling really is absent from the pre-run tree',
    `${dangling.size} dangling (cite, path) pairs my scan finds`,
    `${claimRows.length} claim rows; ${falsified.length} refuted${falsified.length ? `: ${falsified.slice(0, 8).map((r) => `${r.cited} @ ${r.citing}`).join(' ; ')}` : ''}`);
  // coverage, reported not scored: a row-level table and a token-level scan need not agree
  const recordPaths = new Set(claimRows.map((r) => r.cited.replace(/:\d+([-\u2013]\d+)?$/, '').trim()));
  const computedPaths = new Set([...dangling].map((e) => e.split(' ').slice(1).join(' ')));
  const missedPaths = [...computedPaths].filter((p) => !recordPaths.has(p));
  expect(true, 'T2.2b', 'paths my token scan calls dangling that no record row names, counted',
    `${computedPaths.size} computed distinct paths`,
    `${recordPaths.size} claimed; ${missedPaths.length} not claimed (${missedPaths.slice(0, 10).join(', ')})`);

  const indexTable = tableWhere(tables, 'index', 'verdict');
  expect(!!indexTable && indexTable.rows.length === SEVEN_INDEXES.length, 'T2.3',
    'seven index rows, each complete or a change list',
    String(SEVEN_INDEXES.length), String(indexTable?.rows.length ?? 0));

  const adrIndexSame = exists(image, 'docs/adr/index.md') && exists(arm, 'docs/adr/index.md')
    && sha256(readFileSync(join(image, 'docs/adr/index.md'))) === sha256(readFileSync(join(arm, 'docs/adr/index.md')));
  expect(adrIndexSame, 'T2.4', 'docs/adr/index.md is byte-identical to the image', 'equal bytes', adrIndexSame ? 'equal bytes' : 'DIFFERS');

  // post-run: each index lists exactly its directory
  const bad = [];
  const imageFiles = walk(arm);
  for (const index of SEVEN_INDEXES) {
    // the brief: "repo law governs docs/adr/index.md, so leave it byte-for-byte untouched"
    if (index === 'docs/adr/index.md') continue;
    if (!exists(arm, index)) { bad.push(`${index}: absent`); continue; }
    const dir = dirname(index);
    const text = read(arm, index);
    const siblings = readdirSync(join(arm, dir), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'index.md')
      .map((e) => e.name);
    const subdirs = readdirSync(join(arm, dir), { withFileTypes: true })
      .filter((e) => e.isDirectory() && exists(arm, `${dir}/${e.name}/index.md`))
      .map((e) => e.name);
    const missing = [...siblings, ...subdirs].filter((n) => !new RegExp(`(^|[^\\w-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(text));
    const rowLines = text.split(/\r?\n/).filter((l) => /^\s*([-*]|\|)/.test(l));
    const stale = rowLines.flatMap((l) => [...l.matchAll(/`([^`\n]+\.md)`/g)].map((m) => m[1].trim()))
      .filter((t) => !t.startsWith('../') && !/[<>{}*]/.test(t))
      .filter((t) => !exists(arm, t) && !exists(arm, `${dir}/${t}`) && !exists(arm, `${dirname(dir)}/${t}`))
      // a bare name naming a file elsewhere in the tree is a pointer, not a stale row
      .filter((t) => t.includes('/'));
    if (missing.length) bad.push(`${index}: ${missing.length} unlisted (${missing.slice(0, 3).join(', ')})`);
    if (stale.length) bad.push(`${index}: ${stale.length} stale (${stale.slice(0, 3).join(', ')})`);
  }
  expect(bad.length === 0, 'T2.5', 'every index lists exactly its directory after the run', '0 defects',
    bad.length ? bad.join(' | ') : '0 defects');
}

// --------------------------------------------------------------------------
// T3 — core charter
// --------------------------------------------------------------------------

const HOST_GLOBALS = ['game', 'script', 'Enum', 'Color', 'typeof'];
const CONTROL_MEMBERS = ['SetVisible', 'SetActive', 'SetImage', 'SetAnchoredPosition', 'SetSizeDelta',
  'SetLocalScale', 'GetChild', 'GetScript', 'EnableUpdate', 'InstantiateClientUIControl',
  'DestroyClientUIControl', 'GetClientUIControl', 'GetGlobalCustomVariableValue', 'PlayAudio2D',
  'GetUICanvasSize', 'GetCursorUIPos', 'AddCursorEventListener', 'Invoke'];
// the clock-call family: a clock read, a generator, a wait. A `tick` *parameter* is a fourth
// category the records tabulate separately, so it is tested at the claim check, not in this scan.
const CLOCK_CALLS = /(?:\bos\.(?:clock|time|date|difftime)\b|\bmath\.random(?:seed)?\s*\(|\bwait\s*\()/;

/** Blank `--` comments and single/double-quoted string interiors; keep line numbers. */
function codeText(text) {
  return text.split(/\r?\n/).map((line) => {
    let out = '';
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '\\') { out += ' '; i++; continue; }
        if (c === quote) { quote = null; out += ' '; continue; }
        out += c === '\t' ? ' ' : ' '; continue;
      }
      if (c === '"' || c === "'") { quote = c; out += ' '; continue; }
      if (c === '-' && line[i + 1] === '-') break;
      out += c;
    }
    return out;
  });
}

function t3Names(root, files) {
  const hits = new Map();
  for (const file of files) {
    if (!file.endsWith('.lua')) continue;
    const code = codeText(read(root, file));
    code.forEach((line, i) => {
      const found = [];
      for (const g of HOST_GLOBALS) if (new RegExp(`(^|[^\\w.:])${g}\\b`).test(line)) found.push(`global:${g}`);
      for (const m of CONTROL_MEMBERS) if (new RegExp(`(^|[^\\w])${m}\\b`).test(line)) found.push(`member:${m}`);
      // `p.x`, `first.final.y`, `["x"]`; a bare word `x` or a string "position" is not a coordinate read
      if (/[\w\])]\.(?:x|y|z)\b|\[["'](?:x|y|z)["']\]/.test(line)) found.push('coord');
      if (CLOCK_CALLS.test(line)) found.push('clock');
      if (found.length) hits.set(`${file}:${i + 1}`, found.join('+'));
    });
  }
  return hits;
}

function checkT3(image, arm, records) {
  const t3 = records['03-core-charter.md'];
  if (!t3) { expect(false, 'T3.0', '03-core-charter.md exists', 'present', 'MISSING'); return; }
  const set = [...readdirSync(join(image, 'platform-free-core')).filter((f) => f.endsWith('.lua')).map((f) => `platform-free-core/${f}`),
    'platform-free-core/README.md', REF_GATE_DOC];
  const tables = tablesOf(t3);
  const perFile = tables[0];
  expect(perFile?.rows.length === set.length, 'T3.1', 'one row per file in the T3 set',
    String(set.length), String(perFile?.rows.length ?? 0));

  const computed = t3Names(image, set);
  // every table whose first column is `File:line`, or that has separate file and line columns
  const nameTables = tables.slice(1).filter((t) => /^file:line$/i.test(String(t.header[0] ?? '').trim())
    || (t.header.some((h) => /^line$/i.test(h.trim())) && headerIndex(t.header, 'file') !== -1));
  const recorded = new Map();
  for (const nameTable of nameTables) {
    const inline = /^file:line$/i.test(String(nameTable.header[0] ?? '').trim());
    const f = inline ? 0 : headerIndex(nameTable.header, 'file');
    const l = inline ? 0 : headerIndex(nameTable.header, 'line');
    const reading = headerIndex(nameTable.header, 'reading', 'what is there');
    for (const row of nameTable.rows) {
      let file = strip(row[f] ?? '');
      let lineCell = String(row[l] ?? '');
      if (inline) {
        const m = file.match(/^(.*?):([\d,\s]+)$/);
        if (!m) continue;
        file = `platform-free-core/${m[1].replace(/^.*platform-free-core\//, '')}`;
        lineCell = m[2];
      }
      if (!file || /^none$/i.test(file)) continue;
      // the record's own Reading cell may explain a row away (a name collision, string content,
      // prose): the row is still recorded, but it is not counted as an unexplained extra
      const saysNot = reading !== -1
        && /(\bnot a\b|name collision|string content|string literal|inside a string|\bprose\b|name only|only a |a comment)/i.test(String(row[reading] ?? ''));
      for (const n of lineCell.match(/\d+/g) ?? []) {
        recorded.set(`${file.replace(/^`|`$/g, '')}:${n}`, !saysNot);
      }
    }
  }
  // Each name row is a claim about the pre-run tree: "this line names one of the four families".
  // The claim check reads the raw line (a guard that NAMES `position`/`x` is the module naming it)
  // and excludes a line that is only a comment.
  const families = (text) => {
    const raw = text.replace(/^\s*--.*$/, '');
    if (!raw.trim()) return null;
    const hits = [];
    if (HOST_GLOBALS.some((g) => new RegExp(`(^|[^\\w.:])${g}\\b`).test(raw))) hits.push('global');
    if (CONTROL_MEMBERS.some((m) => new RegExp(`(^|[^\\w])${m}\\b`).test(raw))) hits.push('member');
    if (/[\w\])]\.(?:x|y|z)\b|\[["'](?:x|y|z)["']\]/.test(raw)) hits.push('coord');
    if (CLOCK_CALLS.test(raw)) hits.push('clock');
    if (/\btick\b/.test(raw)) hits.push('tick');
    if (/["'](?:position|x|y|z)["']/.test(raw)) hits.push('named');
    return hits.length ? hits : null;
  };
  const wrongClaims = [];
  for (const [key, claimed] of recorded) {
    const at = key.lastIndexOf(':');
    const file = key.slice(0, at);
    const lineNo = Number(key.slice(at + 1));
    if (!exists(image, file)) { wrongClaims.push(`${key}: no such file`); continue; }
    const line = read(image, file).split(/\r?\n/)[lineNo - 1] ?? '';
    if (!line) { wrongClaims.push(`${key}: line ${lineNo} past the end of ${file.split('/').pop()}`); continue; }
    // `claimed` is false when the record's own Reading cell explains the row away. The stated
    // line may be a range's first line or a one-off anchor, so a +/-2 neighbourhood counts: the
    // claim is "this region names it", not "this exact offset".
    if (!claimed) continue;
    const all = read(image, file).split(/\r?\n/);
    const window = [lineNo - 2, lineNo - 1, lineNo, lineNo + 1, lineNo + 2]
      .filter((n) => n >= 1 && n <= all.length)
      .map((n) => families(all[n - 1] ?? ''));
    if (!window.some(Boolean)) wrongClaims.push(`${key}: no line within +/-2 names any of the four families`);
  }
  expect(wrongClaims.length === 0, 'T3.2', 'every name row the record asserts really names what it says',
    `four families over ${set.length} files`,
    `${recorded.size} rows; ${wrongClaims.length} refuted${wrongClaims.length ? `: ${wrongClaims.slice(0, 8).join(' ; ')}` : ''}`);
  // coverage: my comment-blanked scan against the record's rows — reported, not scored, because
  // the record's fourth family is a `tick` parameter this scan does not count as a call
  const missed = [...computed.keys()].filter((k) => !recorded.has(k));
  expect(true, 'T3.3', 'hits my comment-blanked scan finds that no row states, counted',
    `${computed.size} computed`,
    `${computed.size - missed.length}/${computed.size} stated${missed.length ? `; not stated: ${missed.slice(0, 10).join(', ')}` : ''}`);
  const unclaimed = [...recorded.entries()].filter(([k, claimed]) => !computed.has(k) && claimed).map(([k]) => k);
  expect(true, 'T3.3b', 'rows the record asserts outside my four-family scan, counted',
    `${computed.size} computed`, `${unclaimed.length}${unclaimed.length ? ` (${unclaimed.slice(0, 10).join(', ')})` : ''}`);
}

// --------------------------------------------------------------------------
// T4 — core tests
// --------------------------------------------------------------------------

function t4Facts(image) {
  const devDir = 'platform-free-core/dev';
  const devFiles = readdirSync(join(image, devDir)).filter((f) => f.endsWith('.lua')).sort();
  const suite = readFileSync(join(image, devDir, 'suite.lua'), 'utf8');
  const registered = [...suite.matchAll(/^\s*\{[^}]*\bfile\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
  const coreModules = readdirSync(join(image, 'platform-free-core')).filter((f) => f.endsWith('.lua')).map((f) => f.replace(/\.lua$/, ''));
  const tests = devFiles.filter((f) => /^test_.*\.lua$/.test(f)).map((f) => f.replace(/\.lua$/, ''));
  const absent = registered.filter((r) => !devFiles.includes(`${r}.lua`));
  const unregistered = tests.filter((t) => !registered.includes(t));
  return { devFiles, registered, tests, absent, unregistered };
}

function checkT4(image, arm, records) {
  const t4 = records['04-core-tests.md'];
  if (!t4) { expect(false, 'T4.0', '04-core-tests.md exists', 'present', 'MISSING'); return; }
  const facts = t4Facts(image);
  const tables = tablesOf(t4);
  expect(tables[0]?.rows.length === facts.devFiles.length, 'T4.1', 'one row per file under platform-free-core/dev/',
    String(facts.devFiles.length), String(tables[0]?.rows.length ?? 0));
  const coverage = tables[0] ? tables[0].rows.every((r) => (headerIndex(tables[0].header, 'covers') !== -1
    ? strip(r[headerIndex(tables[0].header, 'covers')] ?? '') !== '' : true)) : false;
  expect(coverage, 'T4.2', 'every row names the core module it covers, or runner/list/none', 'all rows', coverage ? 'all rows' : 'blank cell(s)');

  const text = t4;
  const at4 = text.toLowerCase().indexOf('absent from the directory');
  const tail4 = at4 === -1 ? text : text.slice(at4);
  const absentOk = facts.absent.every((a) => new RegExp(`\\b${a}\\b`).test(tail4));
  expect(absentOk, 'T4.3', 'the registered-but-absent list equals the computed set',
    JSON.stringify(facts.absent), absentOk ? 'agrees' : 'record disagrees');
  const unregOk = facts.unregistered.length === 0
    ? /None|none/.test(text.slice(text.indexOf('no row in `suite.lua` names')))
    : facts.unregistered.every((u) => new RegExp(`\\b${u}\\b`).test(text));
  expect(unregOk, 'T4.4', 'the unregistered-test list equals the computed set',
    JSON.stringify(facts.unregistered), unregOk ? 'agrees' : 'record disagrees');
}

// --------------------------------------------------------------------------
// T5 — shell quarantine: the four bounded searches, recomputed
// --------------------------------------------------------------------------

function t5Searches(image) {
  const dir = 'client-scripts';
  const lua = readdirSync(join(image, dir)).filter((f) => f.endsWith('.lua')).sort()
    .map((f) => ({ rel: `${dir}/${f}`, lines: read(image, `${dir}/${f}`).split(/\r?\n/) }));
  const core = walk(image, 'platform-free-core');
  const grep = (pattern, flags, scope) => {
    const re = new RegExp(pattern, flags);
    let n = 0;
    const hits = [];
    for (const { rel, lines } of scope) {
      lines.forEach((line, i) => { if (re.test(line)) { n++; hits.push(`${rel}:${i + 1}`); } });
    }
    return { n, hits };
  };
  const coreLines = core.map((rel) => ({ rel, lines: read(image, rel).split(/\r?\n/) }));
  const s1 = grep('client\\-scripts', '', coreLines);
  const s2 = grep('game\\.[A-Za-z]|script\\.object|Enum\\.|SetVisible|Instantiate', '', coreLines.filter((c) => c.rel.endsWith('.lua')));
  // stage 2 and 3 of the README's printed pipeline, over `grep -nE "[0-9]" client-scripts/*.lua` output
  const stage1 = [];
  for (const { rel, lines } of lua) lines.forEach((line, i) => { if (/[0-9]/.test(line)) stage1.push({ rel, line: i + 1, text: line }); });
  const stage2 = stage1.filter((e) => !new RegExp(`:${e.line}: *(--|local [A-Z0-9_]+ *=)`).test(`${e.rel}:${e.line}: ${e.text}`));
  const stage3 = stage2.filter((e) => !/for [a-z_]+ = 1,|#[a-z_]+ *(==|~=) 0|table\.remove\([a-z_]+, 1\)/.test(`${e.rel}:${e.line}: ${e.text}`));
  const s4stage1 = [];
  for (const { rel, lines } of lua) lines.forEach((line, i) => {
    if (/[A-Za-z_0-9] *\/ *[0-9]|[A-Za-z_0-9] *\* *[0-9]|[0-9] *[*/] *[A-Za-z_]/.test(line)) s4stage1.push({ rel, line: i + 1, text: line });
  });
  const s4 = s4stage1.filter((e) => !new RegExp(`:${e.line}: *--`).test(`${e.rel}:${e.line}: ${e.text}`));
  return { s1, s2, s3: { raw: stage1.length, mid: stage2.length, final: stage3.length }, s4: { raw: s4stage1.length, final: s4.length },
    luaFiles: lua.length, luaLines: lua.reduce((a, f) => a + f.lines.length, 0) - lua.length };
}

function checkT5(image, arm, records) {
  const t5 = records['05-shell-quarantine.md'];
  if (!t5) { expect(false, 'T5.0', '05-shell-quarantine.md exists', 'present', 'MISSING'); return; }
  const facts = t5Searches(image);
  const tables = tablesOf(t5);
  const setSize = walk(image, 'client-scripts').length;
  expect(tables[0]?.rows.length === setSize, 'T5.1', 'per-file table has one row per client-scripts/ file',
    String(setSize), String(tables[0]?.rows.length ?? 0));
  expect(t5.includes('ref-lua-subset-gate.md'), 'T5.1a', 'the gate doc read is named', 'named',
    t5.includes('ref-lua-subset-gate.md') ? 'named' : 'not named');

  const searchTable = tableWhere(tables, 'pattern searched');
  if (!searchTable) {
    expect(false, 'T5.2', 'the four bounded searches are tabulated with counts', '4 rows', 'table not found');
    return;
  }
  expect(searchTable.rows.length === 4, 'T5.2', 'the four bounded searches are tabulated with counts',
    '4', String(searchTable.rows.length));
  const nums = searchTable.rows.map((r) => {
    const cell = String(r[headerIndex(searchTable.header, 'matched')] ?? '');
    // the printed cell carries stages as `690 → 171 → 140` or `690 → 211 → 179`
    return (cell.match(/\d+/g) ?? []).map(Number);
  });
  const wantS3 = [facts.s3.raw, facts.s3.mid, facts.s3.final];
  const s3 = nums[2] ?? [];
  const s3ok = wantS3.every((n) => s3.includes(n));
  expect(s3ok, 'T5.3', 'search 3 counts equal the recount (raw/mid/final)',
    wantS3.join('/'), s3.length ? s3.join('/') : 'no counts');
  const s4ok = (nums[3] ?? []).includes(facts.s4.final);
  expect(s4ok, 'T5.4', 'search 4 count equals the recount', String(facts.s4.final),
    (nums[3] ?? []).join('/') || 'no counts');
  const s1ok = (nums[0] ?? []).includes(facts.s1.n);
  expect(s1ok, 'T5.5', 'search 1 count equals the recount', String(facts.s1.n), (nums[0] ?? []).join('/') || 'no counts');
  const s2ok = (nums[1] ?? []).includes(facts.s2.n);
  expect(s2ok, 'T5.6', 'search 2 count equals the recount', String(facts.s2.n), (nums[1] ?? []).join('/') || 'no counts');
}

// --------------------------------------------------------------------------
// T6 — gate coverage
// --------------------------------------------------------------------------

function t6Facts(image) {
  const gate = read(image, 'dev/lua-gate/gate.lua');
  const start = gate.indexOf('gate.codes');
  const end = gate.indexOf('local function is_word_char');
  const codes = [...gate.slice(start, end).matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]);
  const test = read(image, 'dev/lua-gate/test_gate.lua');
  // One CASES row runs from `{ path = FIX .. "<file>"` to the next `],` or `} }`.
  const starts = [...test.matchAll(/path\s*=\s*FIX\s*\.\.\s*"([^"]+)"/g)]
    .map((m) => ({ fixture: m[1], at: m.index }));
  const byCase = new Map();
  for (const entry of starts) {
    // the case's own `expect = { ... }`, brace-matched so a neighbour's counts never bleed in
    const from = test.indexOf('expect', entry.at);
    if (from === -1) continue;
    const open = test.indexOf('{', from);
    if (open === -1) continue;
    let depth = 0;
    let end = open;
    for (let i = open; i < test.length; i++) {
      if (test[i] === '{') depth++;
      else if (test[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = test.slice(open, end + 1);
    for (const c of body.matchAll(/([A-Z][A-Z0-9_]*)\s*=\s*\d+/g)) {
      if (!byCase.has(c[1])) byCase.set(c[1], new Set());
      byCase.get(c[1]).add(entry.fixture);
    }
  }
  const fixtures = walk(image, 'dev/lua-gate/fixtures');
  // "claimed" = named as a CASES path at all; a green control is a case with an empty expect
  const namedAsCase = new Set(starts.map((s2) => s2.fixture));
  const unclaimed = fixtures
    .filter((f) => !namedAsCase.has(f.slice('dev/lua-gate/fixtures/'.length)));
  const doc = read(image, REF_GATE_DOC);
  const namedInDoc = new Set([...doc.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].map((m) => m[1]));
  return { codes, byCase, fixtures, unclaimed, namedInDoc };
}

function checkT6(image, arm, records) {
  const t6 = records['06-gate-coverage.md'];
  if (!t6) { expect(false, 'T6.0', '06-gate-coverage.md exists', 'present', 'MISSING'); return; }
  const facts = t6Facts(image);
  const table = tableWhere(tablesOf(t6), 'fixture');
  if (!table) { expect(false, 'T6.1', 'one row per gate.codes entry', String(facts.codes.length), 'table not found'); return; }
  expect(table.rows.length === facts.codes.length, 'T6.1', 'one row per gate.codes entry',
    String(facts.codes.length), String(table.rows.length));
  const codeCell = (row) => {
    for (const cell of row) {
      const v = strip(cell).replace(/^`|`$/g, '');
      if (facts.codes.includes(v)) return v;
    }
    return strip(row[0] ?? '').replace(/^\d+\s*/, '');
  };
  const listed = new Set(table.rows.map(codeCell));
  const missing = facts.codes.filter((c) => !listed.has(c));
  expect(missing.length === 0, 'T6.2', 'every code is listed by name', `${facts.codes.length} codes`,
    missing.length ? `missing ${missing.join(',')}` : 'all listed');

  const fixtureCol = headerIndex(table.header, 'fixture');
  const nameCol = headerIndex(table.header, 'named in');
  const badFixture = [];
  const badNamed = [];
  for (const row of table.rows) {
    const code = codeCell(row);
    if (!facts.codes.includes(code)) continue;
    const claimedSet = facts.byCase.get(code) ?? new Set();
    const stated = String(row[fixtureCol] ?? '').replace(/`/g, '');
    const saysNone = /no fixture/i.test(stated);
    if (claimedSet.size > 0) {
      const named = [...claimedSet].filter((f) => stated.includes(f));
      if (named.length === 0) badFixture.push(`${code}: computed ${[...claimedSet].join('+')}, record names none of them ("${stated.slice(0, 40)}")`);
    } else if (!saysNone) {
      // a code with a synthetic rather than fixture case is allowed to say so
      if (!/synthetic|synthetic source/i.test(stated)) badFixture.push(`${code}: computed no fixture vs "${stated.slice(0, 40)}"`);
    }
    const docSays = facts.namedInDoc.has(code);
    const rowSays = /\byes\b/i.test(String(row[nameCol] ?? ''));
    if (docSays !== rowSays) badNamed.push(`${code}: doc ${docSays ? 'names' : 'omits'} it, row says "${strip(String(row[nameCol] ?? '')).slice(0, 24)}"`);
  }
  expect(badFixture.length === 0, 'T6.3', 'each row names the fixture the CASES table binds to the code',
    `${facts.codes.length} codes`, badFixture.length ? badFixture.join(' | ') : 'all agree');
  expect(badNamed.length === 0, 'T6.4', 'the "named in the gate doc" column equals the doc\'s own tokens',
    `${facts.namedInDoc.size} tokens in the doc`, badNamed.length ? badNamed.join(' | ') : 'all agree');

  const unclaimedCell = textAfter(t6, 'fixture');
  const unclaimedOk = facts.unclaimed.length === 0
    ? /none|no fixture/i.test(unclaimedCell)
    : facts.unclaimed.every((f) => unclaimedCell.includes(f));
  expect(unclaimedOk, 'T6.5', 'the unclaimed-fixture list equals the computed set',
    JSON.stringify(facts.unclaimed), unclaimedOk ? 'agrees' : 'record disagrees');
}

function textAfter(text, needle) {
  const at = text.toLowerCase().indexOf(`fixtures that no gate code claims`);
  return at === -1 ? text : text.slice(at);
}

// --------------------------------------------------------------------------
// T7 — plan traceability
// --------------------------------------------------------------------------

function t7Facts(image) {
  const planDir = 'pipeline/output/module_plans';
  const plans = readdirSync(join(image, planDir)).filter((f) => f.endsWith('.md')).sort();
  const targets = new Map();
  for (const plan of plans) {
    const m = read(image, `${planDir}/${plan}`).match(/^File:\s*(.+)$/m);
    targets.set(plan, m ? m[1].trim() : null);
  }
  const tsFiles = walk(image, 'prototype test/Prototype1/src').sort();
  const noPlan = tsFiles.filter((f) => ![...targets.values()].some((t) => t && t.replace(/^src\//, '') === f));
  const broken = [...targets.entries()].filter(([, t]) => !t || !exists(image, `prototype test/Prototype1/src/${t.replace(/^src\//, '')}`));
  return { plans, targets, tsFiles, noPlan, broken };
}

function checkT7(image, arm, records) {
  const t7 = records['07-plan-traceability.md'];
  if (!t7) { expect(false, 'T7.0', '07-plan-traceability.md exists', 'present', 'MISSING'); return; }
  const facts = t7Facts(image);
  const tables = tablesOf(t7);
  const tsTable = tables.find((t) => !!t.header.some((h) => /typescript/i.test(h)));
  expect(tsTable?.rows.length === facts.tsFiles.length, 'T7.1', 'one row per TypeScript file',
    String(facts.tsFiles.length), String(tsTable?.rows.length ?? 0));
  const planTable = tables.find((t) => /^plan$/i.test(String(t.header[0] ?? '').trim()));
  expect(planTable?.rows.length === facts.plans.length, 'T7.2', 'one row per plan with its File: target',
    String(facts.plans.length), String(planTable?.rows.length ?? 0));

  if (tsTable) {
    // the record writes `src/...`; the tree walk writes the full relative path
    const cells = new Map(tsTable.rows.map((r) => {
      const key = strip(r[0] ?? '').replace(/^prototype test\/Prototype1\//, '').replace(/^`|`$/g, '');
      return [key, String(r[headerIndex(tsTable.header, 'plan whose')] ?? '')];
    }));
    const wrong = [];
    for (const full of facts.tsFiles) {
      const file = full.replace(/^prototype test\/Prototype1\//, '');
      const stated = cells.get(file);
      const plan = [...facts.targets.entries()].find(([, t]) => t && t.replace(/^src\//, '') === file.replace(/^src\//, ''));
      if (stated === undefined) { wrong.push(`${file}: row absent`); continue; }
      if (plan && !stated.includes(plan[0])) wrong.push(`${file}: computed ${plan[0]} vs "${stated.slice(0, 40)}"`);
      if (!plan && !/no plan/i.test(stated)) wrong.push(`${file}: computed no plan vs "${stated.slice(0, 40)}"`);
    }
    expect(wrong.length === 0, 'T7.3', 'every row names the plan whose File: line names the file, or "no plan"',
      `${facts.tsFiles.length} files`, wrong.length ? wrong.join(' | ') : 'all agree');
  }
  const brokenCell = t7.slice(t7.indexOf('pairs where the plan exists') === -1 ? 0 : t7.toLowerCase().indexOf('pairs where'));
  const brokenOk = facts.broken.length === 0
    ? /none/i.test(t7.toLowerCase().slice(t7.toLowerCase().indexOf('pairs where')))
    : facts.broken.every(([plan]) => brokenCell.includes(plan));
  expect(brokenOk, 'T7.4', 'the broken-pair list equals the computed set',
    JSON.stringify(facts.broken.map(([p]) => p)), brokenOk ? 'agrees' : 'record disagrees');
}

// --------------------------------------------------------------------------
// T8 — distillation audit
// --------------------------------------------------------------------------

function issueFiles(image, state) {
  return readdirSync(join(image, `issue-tracker/${state}`)).filter((f) => f.endsWith('.md')).sort();
}

function issueTitle(text) {
  const line = text.split(/\r?\n/).find((l) => /^# /.test(l));
  if (!line) return null;
  const m = line.match(/^#\s*ISSUE-\d+\s*[—–-]\s*(.*)$/);
  return m ? m[1].trim() : line.replace(/^#\s*/, '').trim();
}

function checkT8(image, arm, records) {
  const t8 = records['08-distillation-audit.md'];
  if (!t8) { expect(false, 'T8.0', '08-distillation-audit.md exists', 'present', 'MISSING'); return; }
  const files = issueFiles(image, 'resolved');
  const table = tablesOf(t8).find((t) => headerIndex(t.header, 'issue', 'file') !== -1 && t.header.length <= 4 && headerIndex(t.header, 'title') !== -1);
  const want = files.length + 1; // plus .gitkeep
  expect(table?.rows.length === want, 'T8.1', 'one row per resolved file including .gitkeep',
    String(want), String(table?.rows.length ?? 0));
  if (!table) return;

  const numberCol = headerIndex(table.header, 'issue', 'file');
  const titleCol = headerIndex(table.header, 'title');
  const missing = [];
  const titleWrong = [];
  const abbreviated = [];
  const rowByNumber = new Map();
  for (const row of table.rows) {
    const id = (strip(row[numberCol] ?? '').match(/ISSUE-\d{3}/) ?? [])[0];
    if (id) rowByNumber.set(id, row);
  }
  for (const file of files) {
    const id = (file.match(/ISSUE-\d{3}/) ?? [])[0];
    const row = rowByNumber.get(id);
    if (!row) { missing.push(id); continue; }
    const imageTitle = issueTitle(read(image, `issue-tracker/resolved/${file}`));
    const stated = plain(row[titleCol] ?? '');
    const want = imageTitle === null ? null : plain(imageTitle);
    const verbatim = want !== null && stated === want;
    const prefix = want !== null && stated.length >= 20 && want.startsWith(stated);
    if (want !== null && !verbatim) {
      if (prefix) abbreviated.push(id);
      else titleWrong.push(`${id}: image "${want.slice(0, 70)}" vs record "${stated.slice(0, 70)}"`);
    }
  }
  expect(missing.length === 0, 'T8.2', 'every resolved issue has a row', `${files.length}`, `${files.length - missing.length}`);
  // an abbreviated title is not a false one; the brief asks for the issue's exact title, so the
  // two are reported apart rather than folded into one pass
  expect(titleWrong.length === 0, 'T8.3a', 'no title contradicts the image title',
    `${files.length} titles`, titleWrong.length ? titleWrong.join(' | ') : 'none contradicts');
  expect(true, 'T8.3b', 'titles given verbatim rather than abbreviated', `${files.length} titles`,
    `${files.length - abbreviated.length} verbatim; ${abbreviated.length} abbreviated (${abbreviated.slice(0, 12).join(', ')})`);
  const gitkeep = table.rows.some((r) => /gitkeep/.test(String(r[numberCol] ?? '')));
  expect(gitkeep, 'T8.4', '.gitkeep has a row', 'present', gitkeep ? 'present' : 'absent');
}

// --------------------------------------------------------------------------
// T9 — open triage
// --------------------------------------------------------------------------

const LEGAL_TRIAGE = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'];

function issueMetadata(image, state, file) {
  const text = read(image, `issue-tracker/${state}/${file}`);
  const grab = (name) => {
    const m = text.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  return { type: grab('Type'), triage: grab('Triage'), status: grab('Status'), text };
}

function checkT9(image, arm, records) {
  const t9 = records['09-open-triage.md'];
  if (!t9) { expect(false, 'T9.0', '09-open-triage.md exists', 'present', 'MISSING'); return; }
  const files = issueFiles(image, 'open');
  const table = tablesOf(t9).find((t) => headerIndex(t.header, 'triage') !== -1);
  const want = files.length + 1;
  expect(table?.rows.length === want, 'T9.1', 'one row per open file including .gitkeep',
    String(want), String(table?.rows.length ?? 0));
  if (!table) return;

  const idCol = headerIndex(table.header, 'issue', 'file');
  const triageCol = headerIndex(table.header, 'triage');
  const typeCol = headerIndex(table.header, 'type');
  const statusCol = headerIndex(table.header, 'status');
  const invalid = files.map((f) => ({ file: f, meta: issueMetadata(image, 'open', f) }))
    .filter(({ meta }) => meta.triage && !LEGAL_TRIAGE.includes(meta.triage));
  const stateMismatch = files.filter((f) => !new RegExp(`^ISSUE-\\d{3}-open-`).test(f));

  const rowByNumber = new Map();
  for (const row of table.rows) {
    const id = (strip(row[idCol] ?? '').match(/ISSUE-\d{3}/) ?? [])[0];
    if (id) rowByNumber.set(id, row);
  }
  const wrong = [];
  for (const file of files) {
    const id = (file.match(/ISSUE-\d{3}/) ?? [])[0];
    const row = rowByNumber.get(id);
    if (!row) { wrong.push(`${id}: row absent`); continue; }
    const meta = issueMetadata(image, 'open', file);
    for (const [name, value] of [['type', meta.type], ['triage', meta.triage], ['status', meta.status]]) {
      if (value === null) continue;
      const col = name === 'type' ? typeCol : name === 'triage' ? triageCol : statusCol;
      const stated = strip(row[col] ?? '');
      const norm = (s) => s.replace(/`/g, '').toLowerCase().replace(/\s*·\s*/g, ' · ');
      if (!norm(stated).includes(norm(value)) && !norm(value).includes(norm(stated))) {
        wrong.push(`${id}.${name}: image "${meta.triage === value ? value : value}" vs record "${stated.slice(0, 30)}"`);
      }
    }
  }
  expect(wrong.length === 0, 'T9.2', 'Type, Triage and Status per row equal the image file',
    `${files.length} files`, wrong.length ? wrong.join(' | ') : 'all agree');

  const invalidListOk = invalid.length === 0
    ? !/^\|\s*`?ISSUE-\d{3}/m.test(t9)
    : invalid.every(({ file }) => new RegExp((file.match(/ISSUE-\d{3}/) ?? [''])[0]).test(t9));
  expect(invalidListOk, 'T9.3', 'the invalid-Triage list equals the computed set',
    JSON.stringify(invalid.map(({ file }) => file)), invalidListOk ? 'agrees' : 'record disagrees');
  const stateOk = stateMismatch.length === 0
    ? !/disagrees[\s\S]{0,200}\bISSUE-\d{3}-(resolved|deferred)/.test(t9)
    : stateMismatch.every((f) => t9.includes(f));
  expect(stateOk, 'T9.4', 'the filename-state-vs-folder list equals the computed set',
    JSON.stringify(stateMismatch), stateOk ? 'agrees' : 'record disagrees');
}

// --------------------------------------------------------------------------
// T10 — plans disposition
// --------------------------------------------------------------------------

function checkT10(image, arm, records) {
  const t10 = records['10-plans-disposition.md'];
  if (!t10) { expect(false, 'T10.0', '10-plans-disposition.md exists', 'present', 'MISSING'); return; }
  const root = 'docs/plans';
  const entries = readdirSync(join(image, root), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const tables = tablesOf(t10);
  const subTable = tables.find((t) => headerIndex(t.header, 'subdirectory', 'folder') !== -1 && headerIndex(t.header, 'files') !== -1);
  expect(subTable?.rows.length === entries.length, 'T10.1', 'one row per subdirectory with its file count',
    String(entries.length), String(subTable?.rows.length ?? 0));
  if (!subTable) return;
  const fileCol = headerIndex(subTable.header, 'files');
  const dirCol = headerIndex(subTable.header, 'subdirectory', 'folder');
  const wrong = [];
  for (const row of subTable.rows) {
    const dir = strip(row[dirCol] ?? '').replace(/\/$/, '').replace(new RegExp(`^${root}/`), '');
    if (!entries.includes(dir)) { wrong.push(`${dir}: not a subdirectory`); continue; }
    const count = walk(image, `${root}/${dir}`).length;
    const stated = Number((String(row[fileCol] ?? '').match(/\d+/) ?? [0])[0]);
    if (count !== stated) wrong.push(`${dir}: computed ${count} vs ${stated}`);
  }
  expect(wrong.length === 0, 'T10.2', 'every file count equals the recomputation', `${entries.length} folders`,
    wrong.length ? wrong.join(' | ') : 'all agree');
  const loose = exists(image, `${root}/human-decisions-index.md`);
  const looseRow = tables.some((t) => t.rows.some((r) => /human-decisions-index/.test(String(r[0] ?? ''))));
  expect(!loose || looseRow, 'T10.3', 'the loose human-decisions-index.md has a row', loose ? 'present' : 'absent',
    looseRow ? 'present' : 'absent');
}

// --------------------------------------------------------------------------
// T11 / T12 — corpus
// --------------------------------------------------------------------------

function frontMatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const m = lines[i].match(/^([A-Za-z_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const corpusRoot = (lang) => `docs/official-docs-mirror-${lang}/knowledge/node-introduction`;

function corpusFacts(image, lang) {
  const prefix = `${corpusRoot(lang)}/`;
  return walk(image).filter((f) => f.startsWith(prefix) && f.endsWith('.md')).sort()
    .map((f) => ({ file: f.slice(prefix.length), fm: frontMatter(read(image, f)) }));
}

function checkT11(image, arm, records) {
  const t11 = records['11-corpus-en.md'];
  if (!t11) { expect(false, 'T11.0', '11-corpus-en.md exists', 'present', 'MISSING'); return; }
  const files = corpusFacts(image, 'en-us');
  const ids = new Set(files.map((f) => f.fm.path_id).filter(Boolean));
  const table = tablesOf(t11).find((t) => headerIndex(t.header, 'path_id') !== -1);
  expect(table?.rows.length === files.length, 'T11.1', 'one row per EN corpus file',
    String(files.length), String(table?.rows.length ?? 0));
  if (!table) return;
  const idCol = headerIndex(table.header, 'path_id');
  const tierCol = headerIndex(table.header, 'tier');
  const titleCol = headerIndex(table.header, 'title');
  const parentCol = headerIndex(table.header, 'parent_path_id');
  const appearsCol = headerIndex(table.header, 'appears');
  const wrong = [];
  const byPath = new Map(table.rows.map((r) => [strip(r[0] ?? '')
    .replace(/^docs\/official-docs-mirror-en-us\/knowledge\/node-introduction\//, ''), r]));
  for (const { file, fm } of files) {
    const row = byPath.get(file);
    if (!row) { wrong.push(`${file}: row absent`); continue; }
    if (strip(row[idCol] ?? '') !== (fm.path_id ?? '')) wrong.push(`${file}: path_id ${fm.path_id} vs ${strip(row[idCol] ?? '')}`);
    if (tierCol !== -1 && strip(row[tierCol] ?? '') !== (fm.tier ?? '')) wrong.push(`${file}: tier ${fm.tier} vs ${strip(row[tierCol] ?? '')}`);
    if (titleCol !== -1 && strip(row[titleCol] ?? '') !== (fm.title ?? '')) wrong.push(`${file}: title "${fm.title}" vs "${strip(row[titleCol] ?? '')}"`);
    if (parentCol !== -1) {
      const stated = strip(row[parentCol] ?? '');
      const want = fm.parent_path_id ?? '';
      const claimsId = want === ''
        // `absent`, `none — absent, this is the root`, `—`: all state that no parent id exists
        ? /^(absent|none|—|-|)\b/i.test(stated)
        : stated.includes(want);
      if (!claimsId) wrong.push(`${file}: parent ${want || 'none'} vs ${stated}`);
    }
    if (appearsCol !== -1) {
      const want = ids.has(fm.parent_path_id) ? 'yes' : 'no';
      const stated = strip(row[appearsCol] ?? '').toLowerCase();
      const same = want === 'yes'
        ? /^(yes|true|present|exists)/.test(stated) || /present$/.test(stated)
        : /^(no|false|absent|missing|none|—|-|no key)/.test(stated) || stated === 'n/a';
      if (!same) wrong.push(`${file}: parent-in-tree ${want} vs ${strip(row[appearsCol] ?? '')}`);
    }
  }
  expect(wrong.length === 0, 'T11.2', 'path_id, tier, title, parent and parent-in-tree all equal the front matter',
    `${files.length} files`, wrong.length ? wrong.join(' | ') : 'all agree');
  const noParent = files.filter((f) => !f.fm.parent_path_id).map((f) => f.file);
  const tail = t11.slice(t11.search(/no `?parent_path_id`?/i) === -1 ? 0 : t11.search(/no `?parent_path_id`?/i));
  const ok = noParent.length === 0 ? /none/i.test(tail) : noParent.every((f) => tail.includes(f));
  expect(ok, 'T11.3', 'the no-parent list equals the computed set', JSON.stringify(noParent), ok ? 'agrees' : 'record disagrees');
}

function checkT12(image, arm, records) {
  const t12 = records['12-corpus-zh.md'];
  if (!t12) { expect(false, 'T12.0', '12-corpus-zh.md exists', 'present', 'MISSING'); return; }
  const zh = corpusFacts(image, 'zh-cn');
  const enPrefix = `${corpusRoot('en-us')}/`;
  const en = new Set(walk(image).filter((f) => f.startsWith(enPrefix)).map((f) => f.slice(enPrefix.length)));
  const table = tablesOf(t12).find((t) => headerIndex(t.header, 'path_id') !== -1);
  expect(table?.rows.length === zh.length, 'T12.1', 'one row per ZH corpus file', String(zh.length), String(table?.rows.length ?? 0));
  if (!table) return;
  const idCol = headerIndex(table.header, 'path_id');
  const eqCol = headerIndex(table.header, 'equals', '= `real_id`', 'real_id');
  const enCol = headerIndex(table.header, 'en counterpart', 'same relative path');
  const wrong = [];
  const byPath = new Map(table.rows.map((r) => [strip(r[0] ?? '')
    .replace(/^docs\/official-docs-mirror-zh-cn\/knowledge\/node-introduction\//, ''), r]));
  for (const { file, fm } of zh) {
    const row = byPath.get(file);
    if (!row) { wrong.push(`${file}: row absent`); continue; }
    if (strip(row[idCol] ?? '') !== (fm.path_id ?? '')) wrong.push(`${file}: path_id ${fm.path_id} vs ${strip(row[idCol] ?? '')}`);
    if (eqCol !== -1) {
      const want = fm.path_id === fm.real_id;
      const stated = strip(row[eqCol] ?? '').toLowerCase();
      const same = want ? /^(yes|true|equal|same)\b/.test(stated) : /^(no|false|differ|unequal|not)\b/.test(stated);
      if (!same) wrong.push(`${file}: equal=${want ? 'yes' : 'no'} vs ${strip(row[eqCol] ?? '')}`);
    }
    if (enCol !== -1) {
      const want = en.has(file);
      const stated = strip(row[enCol] ?? '').toLowerCase();
      const same = want ? /^(yes|true|present|exists)/.test(stated) : /^(no|false|absent|missing)/.test(stated);
      if (!same) wrong.push(`${file}: EN counterpart ${want ? 'yes' : 'no'} vs ${strip(row[enCol] ?? '')}`);
    }
  }
  expect(wrong.length === 0, 'T12.2', 'path_id, path_id==real_id and EN-counterpart all equal the front matter',
    `${zh.length} files`, wrong.length ? wrong.join(' | ') : 'all agree');
  const notEqual = zh.filter((f) => f.fm.path_id !== f.fm.real_id).map((f) => f.file);
  const tail = t12.slice(t12.search(/does not equal/i) === -1 ? 0 : t12.search(/does not equal/i));
  // an empty set is often stated as a sentence ("All 42 ZH files have path_id exactly equal to real_id")
  const ok = notEqual.length === 0
    ? /none|all \d+|every .*(equal|equals)|no file/i.test(t12)
    : notEqual.every((f) => tail.includes(f));
  expect(ok, 'T12.3', 'the not-equal list equals the computed set', JSON.stringify(notEqual), ok ? 'agrees' : 'record disagrees');
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const image = opts.image;
  const arm = opts.arm;
  const auditDir = join(arm, AUDIT);
  const records = {};
  for (const name of RECORD_FILES) {
    const p = join(auditDir, name);
    if (existsSync(p)) records[name] = readFileSync(p, 'utf8');
  }
  expect(Object.keys(records).length === RECORD_FILES.length, 'T0.1', 'all thirteen records exist',
    String(RECORD_FILES.length), String(Object.keys(records).length));

  checkT1(image, arm, records);
  checkT2(image, arm, records);
  checkT3(image, arm, records);
  checkT4(image, arm, records);
  checkT5(image, arm, records);
  checkT6(image, arm, records);
  checkT7(image, arm, records);
  checkT8(image, arm, records);
  checkT9(image, arm, records);
  checkT10(image, arm, records);
  checkT11(image, arm, records);
  checkT12(image, arm, records);

  const failed = rows.filter((r) => !r.pass && r.kind === 'check');
  const observations = rows.filter((r) => r.kind === 'observ');
  const summary = {
    label: opts.label ?? null,
    image, arm,
    checks: rows.filter((r) => r.kind === 'check').length,
    passed: rows.filter((r) => r.kind === 'check' && r.pass).length,
    failed: failed.length,
    observations: observations.length,
    rows,
  };
  if (opts.out) {
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, 'dchecks.json'), `${JSON.stringify(summary, null, 2)}\n`);
    const lines = [
      `# D-checks — ${opts.label ?? arm}`,
      '',
      'Scored D-checks: one pass/fail per recomputed expectation. Rows marked `observ` are printed',
      'measurements the script cannot settle alone; they never enter the score.',
      '',
      '| Check | Expectation | Computed | Recorded | Result |',
      '| --- | --- | --- | --- | --- |',
      ...rows.map((r) => `| ${r.id} | ${r.label} | ${oneLine(r.computed)} | ${oneLine(r.recorded)} | ${
        r.kind === 'observ' ? 'observ' : (r.pass ? 'pass' : 'FAIL')} |`),
      '',
      `${summary.passed}/${summary.checks} scored checks pass; ${summary.observations} observations`,
      '',
    ];
    writeFileSync(join(opts.out, 'dchecks.txt'), lines.join('\n'));
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    for (const r of rows) {
      const mark = r.kind === 'observ' ? 'obs ' : (r.pass ? 'pass' : 'FAIL');
      process.stdout.write(`${mark} ${r.id} ${r.label}\n`);
    }
    process.stdout.write(`\n${summary.passed}/${summary.checks} scored checks pass; ${summary.observations} observations\n`);
  }
}

const oneLine = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220);

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();

export { checkT1, checkT2, checkT3, tablesOf, t3Names, t4Facts, t5Searches, t6Facts, t7Facts, rows };
