#!/usr/bin/env node
// Private-text gate.
//
// Why the denylist is not committed: a committed list of the names this repo
// refuses to publish would itself publish them. The list is owner-local
// (`dev/privacy/private-tokens.local.txt`, gitignored). Without it the gate
// still enforces the structural rules below, so a missing list lowers coverage
// but never disables the gate.
//
// Structural rules (always on):
//   1. bare `TZhen` outside an allowed home path. Allowed shapes:
//      C:\Users\TZhen\, C:/Users/TZhen/, C:\\Users\\TZhen\\ and deeper
//      backslash-escape runs; same for TZ.
//   2. an absolute home path `[A-Za-z]:[\\/]+Users[\\/]+<name>` whose name is
//      neither TZhen/TZ nor a placeholder (A/x-only names such as AAAAA, AA,
//      xxxxx; template slots such as <user>; punctuation-only such as …).
//      An empty name is not a home path at all and does not hit.
//   3. Han characters inside dev/bench/fixtures/sim/ (that fixture set is fully
//      masked and must stay that way; live/runb keep legitimate Han text).
//
// Encoding: a UTF-16 file with a BOM is decoded and scanned. PowerShell 5's
// `Out-File` default is UTF-16LE with a FF FE BOM, and its NUL bytes used to
// trip the binary skip, so the whole file went unchecked (ISSUE-493).
//
// Usage: node dev/privacy/private-text-gate.mjs [--tokens <file>] [--root <dir>]
// Default root is the git repo root; default mode scans `git ls-files` only.
// With --root the whole directory tree is scanned (used by tests).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';

const DEFAULT_TOKENS = 'dev/privacy/private-tokens.local.txt';
// The gate and its test name the username and plant deliberate hits; they are
// tooling, not content. The local list is the denylist itself. None is scanned.
const SELF_FILES = new Set([
  'dev/privacy/private-text-gate.mjs',
  'dev/privacy/private-text-gate.test.mjs',
  DEFAULT_TOKENS,
]);
// Both home patterns match a Windows drive path only, so their username is
// case-insensitive on every platform the gate runs on: Windows compares a
// profile name that way, and folding here does not depend on `process.platform`.
const ALLOWED_HOME = /[A-Za-z]:[\\/]+Users[\\/]+(?:TZhen|TZ)(?![A-Za-z0-9_])/giu;
const FOREIGN_HOME = /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s]+)/gu;
const HAN = /\p{Script=Han}/u;
const PLACEHOLDER = /^[Ax]+$/;
const TEMPLATE_SLOT = /^<[^<>]*>$/u;

function isPlaceholder(name) {
  if (name === '' || PLACEHOLDER.test(name) || TEMPLATE_SLOT.test(name)) return true;
  // `…`, `...`, `***`: no letter or digit, so not a username.
  return !/[\p{L}\p{N}]/u.test(name);
}

function fail(message) {
  console.error(`private-text-gate: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: optionsOf([['--tokens', 'string'], ['--root', 'string']]),
    refuse: fail,
    help: 'usage: node dev/privacy/private-text-gate.mjs [--tokens <file>] [--root <dir>]\n',
    // This script's unknown-argument text carries a colon; keep it exactly.
    unknown: (rawName) => `unknown argument: ${rawName}`,
  });
  return { tokens: values.tokens ?? null, root: values.root ?? null };
}

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    fail('not inside a git repository and no --root given');
  }
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

function listFiles(root, useGit) {
  if (!useGit) return walk(root).sort();
  const raw = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' });
  return raw.split('\0').filter(Boolean).map((rel) => join(root, rel));
}

function toDisplay(root, abs) {
  return relative(root, abs).split(sep).join('/');
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function readTokens(path) {
  const text = readFileSync(path, 'utf8');
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((literal) => ({ literal, pattern: new RegExp(escapeRegExp(literal), 'giu') }));
}

/**
 * Decode a file for scanning: UTF-16 text with a BOM is decoded, and any other
 * NUL-containing buffer is still skipped as binary (ISSUE-493).
 * @param {Buffer} buf
 * @returns {string|null} the text, or null when the file is binary
 */
function textOf(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // A trailing odd byte is not a code unit; drop it instead of throwing.
    const end = buf.length - ((buf.length - 2) % 2);
    const body = Buffer.from(buf.subarray(2, end));
    body.swap16();
    return body.toString('utf16le');
  }
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString('utf8');
}

const opts = parseArgs(process.argv.slice(2));
const explicitRoot = opts.root !== null;
const root = explicitRoot ? resolve(opts.root) : repoRoot();

if (!existsSync(root)) fail(`root does not exist: ${root}`);

const tokensPath = opts.tokens !== null
  ? resolve(opts.tokens)
  : join(root, DEFAULT_TOKENS);
if (opts.tokens !== null && !existsSync(tokensPath)) fail(`token list does not exist: ${tokensPath}`);
let tokens = [];
if (existsSync(tokensPath)) {
  tokens = readTokens(tokensPath);
} else {
  console.log(`note: no token list at ${tokensPath}; structural checks only`);
}

let hits = 0;
const hitFiles = new Set();

for (const abs of listFiles(root, !explicitRoot)) {
  if (abs === tokensPath) continue;
  let buf;
  try {
    buf = readFileSync(abs);
  } catch (error) {
    // Fail CLOSED: an unreadable listed file could hide private text, so it is
    // a named refusal, never a silent skip (ISSUE-389).
    fail(`cannot read listed file ${toDisplay(root, abs)}: ${error.message}`);
  }
  const text = textOf(buf);
  if (text === null) continue;
  const display = toDisplay(root, abs);
  if (SELF_FILES.has(display)) continue;
  const fileHits = [];

  // 1. bare TZhen outside an allowed home path, in any case
  const allowed = [...text.matchAll(ALLOWED_HOME)].map((m) => [m.index, m.index + m[0].length]);
  for (const m of text.matchAll(/TZhen/gi)) {
    if (allowed.some(([a, b]) => m.index >= a && m.index < b)) continue;
    fileHits.push({ index: m.index, reason: 'bare private username TZhen' });
  }

  // 2. foreign absolute home path
  for (const m of text.matchAll(FOREIGN_HOME)) {
    const raw = m[1].replace(/[.,;:!?)\]}"'`]+$/gu, '');
    // The path form is Windows, so its name is case-insensitive: `tzhen` is the
    // owner's home, not a foreign one, and `c:\Users\tz\` is allowed too.
    const name = raw.toLowerCase();
    if (name === 'tzhen' || name === 'tz' || isPlaceholder(raw)) continue;
    fileHits.push({ index: m.index, reason: `foreign home path username "${name}"` });
  }

  // 3. Han characters inside dev/bench/fixtures/sim/
  const inSimFixtures = display === 'dev/bench/fixtures/sim'
    || display.startsWith('dev/bench/fixtures/sim/');
  if (inSimFixtures) {
    const seen = new Set();
    for (const m of text.matchAll(new RegExp(HAN.source, 'gu'))) {
      const line = lineAt(text, m.index);
      if (seen.has(line)) continue;
      seen.add(line);
      fileHits.push({ index: m.index, reason: 'Han text in dev/bench/fixtures/sim' });
    }
  }

  // 4. owner-local token list
  for (const { pattern } of tokens) {
    for (const m of text.matchAll(pattern)) {
      fileHits.push({ index: m.index, reason: 'private token match' });
    }
  }

  if (fileHits.length === 0) continue;
  hitFiles.add(display);
  fileHits.sort((a, b) => a.index - b.index);
  for (const hit of fileHits) {
    hits += 1;
    console.log(`${display}:${lineAt(text, hit.index)}: ${hit.reason}`);
  }
}

if (hits > 0) {
  console.log(`${hits} hits in ${hitFiles.size} files`);
  process.exit(1);
}
console.log('PASS: no private text');
