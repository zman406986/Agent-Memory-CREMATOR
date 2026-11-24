#!/usr/bin/env node
/**
 * The bench arm's read boundary (ISSUE-039).
 *
 * The launcher bounds WRITES in prose and, before this module, bounded reads
 * nowhere: a tool call could name any path on the machine, and Run B's racoons
 * arm read the other arm's `derive-vanilla.json` and the campaign's
 * `build/VERDICT.md` from a shared evidence root one directory above the arm.
 *
 * Two mechanisms live here, and the launcher uses both:
 *
 *   1. **Layout.** An arm's world is a directory that holds that arm's tree and
 *      that arm's evidence dir and nothing else: with `--world <dir>` the
 *      launcher requires `<dir>` to contain the arm and the evidence dir, and
 *      refuses a world root whose top level already carries campaign-level
 *      derivation (`build/`, `VERDICT.md`, `derive-*.json`) or another arm's
 *      evidence dir. The shared-root shape Run B used cannot be recreated
 *      silently.
 *   2. **Detection.** `classifyToolCalls` reads every `tool/call` in the
 *      session log, extracts the filesystem paths its arguments name, and
 *      separates them into inside the arm's world, allow-listed, inside the
 *      arm's evidence dir (the session log, journal, ledger and blobs the
 *      harness itself writes there: a tool call naming it is a violation even
 *      when the directory sits inside the world), inside the campaign tree but
 *      outside the world (a cross-arm / campaign-artifact read: the run fails
 *      and names the call), and outside the campaign altogether (recorded
 *      evidence, not a gate).
 *
 * Why the split at the campaign tree: `..` cannot be made unreachable on
 * Windows without a path sandbox, and dsh 0.2.1-rc.2 has none
 * (`subagent-deny.md`: `ToolRestriction` filters tools, not paths). So the gate
 * is the line that matters for A/B validity — any read of the bench's own
 * material outside this arm — while a read of `C:\Windows` is recorded so a
 * reader can see the surface without failing an otherwise sound run.
 *
 * What this cannot catch: `cd <dir>` followed by a relative read, or a path
 * assembled at runtime from variables the launcher cannot see. Both are stated
 * in `runbook.md`; a path mount would be needed to close them.
 *
 * The same gap let a third shape through silently: a `git` call names no path,
 * so it was invisible here, yet `git` resolves `.git` upward on its own. The
 * vanilla arm of the 2026-10-28 extended campaign ran
 * `git rev-parse --is-inside-work-tree; git log --oneline -3` from a world with
 * no `.git` and returned commit subjects from this repository, above the
 * campaign root. That is now a recorded `gitChannel` row: still not a gate (the
 * content is outside the campaign, so the campaign line does not hold), but
 * named in the launcher's message so a verdict can see it.
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

/** Case-folded containment; Windows paths are case-insensitive. */
export function inside(outer, inner) {
  const a = resolve(outer).toLowerCase();
  const b = resolve(inner).toLowerCase();
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/** `true` when `a` and `b` name the same path. */
function samePath(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

/**
 * The tree outside the arm's world that must not be READ: the campaign. What
 * lives there is the other arm's material and every derived artifact.
 *
 * - `--world <dir>`: the campaign is the world's parent, or its grandparent when
 *   the world sits under a `worlds/` collector (`$EV/worlds/<arm>` → `$EV`), so
 *   a read of a sibling world AND of the campaign's `derive-*.json` / `build/`
 *   is a violation.
 * - otherwise `--root` when it holds the arm or the evidence dir (the default
 *   mock layout).
 * - otherwise the directory that holds the evidence dir, when the arm sits
 *   inside it too (the legacy live layout `$EV/bench-<arm>` + `$EV/arms/<arm>`).
 * - otherwise the evidence dir's parent: the campaign evidence dir, which is
 *   exactly what holds the other arms' dirs.
 */
export function campaignRootFor({ worldRoot, root, armDir, evidenceDir }) {
  if (worldRoot !== null) {
    const parent = dirname(resolve(worldRoot));
    return basename(parent).toLowerCase() === 'worlds' ? dirname(parent) : parent;
  }
  if (inside(root, armDir) || inside(root, evidenceDir)) return resolve(root);
  const evidenceParent = dirname(resolve(evidenceDir));
  if (inside(evidenceParent, armDir)) return evidenceParent;
  return dirname(resolve(evidenceDir));
}

const DERIVE_FILE = /^derive-.*\.(json|txt)$/iu;
const ARM_EVIDENCE_DIR = /^(racoons|vanilla)(-|$)/iu;
/** Files that make a top-level directory an evidence dir. */
const EVIDENCE_MARKERS = ['result.json', 'deny-probe.txt'];

function defaultReaddir(dir) {
  return readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, dir: entry.isDirectory() }));
}

/**
 * Why a world root is not isolated, one sentence per offender. An empty list is
 * a world that holds only this arm's material.
 *
 * The scan is top-level only (cheap, and the layout contract is top-level): a
 * `build/` tree, a `VERDICT.md`, a `derive-*.json`, or another arm's evidence
 * dir at the world root is exactly the shape that leaked in Run B.
 *
 * @param {{worldRoot: string, armDir: string, evidenceDir: string,
 *          readdir?: (dir: string) => {name: string, dir: boolean}[]}} input
 * @returns {string[]}
 */
export function worldLayoutViolations({ worldRoot, armDir, evidenceDir, readdir = defaultReaddir }) {
  const problems = [];
  if (!inside(worldRoot, armDir)) problems.push(`the arm ${armDir} is outside the world ${worldRoot}`);
  if (!inside(worldRoot, evidenceDir)) problems.push(`the evidence dir ${evidenceDir} is outside the world ${worldRoot}`);
  if (samePath(armDir, worldRoot)) {
    problems.push(`the arm IS the world root ${worldRoot}; the arm needs its own directory so '..' reaches nothing else`);
  }
  let entries;
  try {
    entries = readdir(worldRoot);
  } catch {
    // A world root that does not exist yet is created by the run itself.
    return problems;
  }
  for (const entry of entries) {
    const full = join(worldRoot, entry.name);
    if (entry.dir && entry.name.toLowerCase() === 'build') {
      problems.push(`${full} is a campaign build tree; derivation never lives inside an arm's world`);
      continue;
    }
    if (!entry.dir && entry.name === 'VERDICT.md') {
      problems.push(`${full} is a campaign verdict; derivation never lives inside an arm's world`);
      continue;
    }
    if (!entry.dir && DERIVE_FILE.test(entry.name)) {
      problems.push(`${full} is a derivation artifact; derivation never lives inside an arm's world`);
      continue;
    }
    if (entry.dir && ARM_EVIDENCE_DIR.test(entry.name) && !samePath(full, evidenceDir)
      && EVIDENCE_MARKERS.some((marker) => hasEntry(full, marker))) {
      problems.push(`${full} is another arm's evidence dir; give each arm its own world (--world <dir>)`);
    }
  }
  return problems;
}

function hasEntry(dir, name) {
  try {
    return defaultReaddir(dir).some((entry) => entry.name === name);
  } catch {
    return false;
  }
}

/**
 * Windows absolute paths and `..`-relative traversal: what the launcher can
 * judge.
 *
 * A token is either quoted (then it may contain spaces and ends at its closing
 * quote) or bare (then it ends at the first whitespace or shell punctuation).
 * The distinction is the ISSUE-047 fix: the old pattern let a bare token run to
 * the next quote/newline, so `Get-ChildItem <dir> -Force` yielded
 * `<dir> -Force` and the launcher failed a clean run on a path that does not
 * exist. The quoted branch is listed first so a quoted path wins over the bare
 * prefix the same position would also match.
 */
const WIN_ABS = /(?<=^|[\s"'`=(:,;|&])(?:"([A-Za-z]:[\\/][^"\r\n<>|;]*)"|'([A-Za-z]:[\\/][^'\r\n<>|;]*)'|`([A-Za-z]:[\\/][^`\r\n<>|;]*)`|([A-Za-z]:[\\/][^\s"'`\r\n<>|;]*))/gu;
const POSIX_ABS = /(?<=^|[\s"'`=(:,;|&])(?:"(\/[A-Za-z0-9._\-][^"\r\n<>|;]*)"|'(\/[A-Za-z0-9._\-][^'\r\n<>|;]*)'|`(\/[A-Za-z0-9._\-][^`\r\n<>|;]*)`|(\/[A-Za-z0-9._\-][^\s"'`\r\n<>|;]*))/gu;
const PARENT_REL = /(?<=^|[\s"'`=(:,;|&])(?:"((?:\.\.[\\/])[^"\r\n<>|;]*)"|'((?:\.\.[\\/])[^'\r\n<>|;]*)'|`((?:\.\.[\\/])[^`\r\n<>|;]*)`|((?:\.\.[\\/])[^\s"'`\r\n<>|;]*))/gu;

/** The path text of the first matching capture group of a quoted/bare token. */
function tokenOf(match) {
  return match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
}

/** Trim the punctuation a shell line leaves around a bare path. */
function tidyPath(raw) {
  let text = raw.trim();
  text = text.replace(/^(['"`[(])/u, '');
  text = text.replace(/[),;:]+$/u, '');
  while (text.length > 1 && (text.endsWith('\\') || text.endsWith('/'))) text = text.slice(0, -1);
  return text;
}

// ── Pattern operands are not paths (2026-11-09 pair-b) ──────────────────────
// Four vanilla-arm `pwsh` calls read `docs/project`, `docs/guides` and
// `docs/adr` and were failed on `$p -like '../*'`: a wildcard test on a
// string. The same calls define `$rx = [regex]'(?:\.\./)?...'`, an escaped
// regex. Neither token names a location. Two narrow rules keep a pattern out
// of the path scan while a literal read still enters it.

/**
 * The closed list of PowerShell words whose next argument is a PATTERN: the
 * `[regex]` cast, the operators that take a regex or wildcard (`-match`,
 * `-replace`, `-split`, `-like` and their `-i`/`-c`/`-not` spellings),
 * `Select-String -Pattern`, and the name filters `-Filter`/`-Include`/
 * `-Exclude`. A general "looks like a regex" test would excuse real reads;
 * these words are the ones PowerShell itself never opens as a file.
 */
const PATTERN_WORD = /^(?:\[regex\]|-(?:[ic])?(?:match|replace|split|like)|-(?:notmatch|notlike)|-(?:pattern|filter|include|exclude))$/iu;

/** A variable that conventionally holds a pattern. Exact names plus optional
 *  digits, so `$rel` (a relative path) is not mistaken for `$re`. */
const PATTERN_VARIABLE = /^\$(?:rx|re|regex|pattern)\d*$/iu;

/** A character that cannot occur in a literal Windows file name: `*`, `?` and
 *  `|` are reserved. A token carrying one is a wildcard pattern, not a path —
 *  narrower than "every regex metacharacter", and unambiguous on Windows. */
const PATTERN_TOKEN_CHARACTER = /[*?|]/u;

/** Commands whose argument list names files to READ. A wildcard token is a real
 *  location only in one of these; elsewhere it is a pattern (a `-like` test, a
 *  printed string, code text). `ls ..` is still the parent directory, but a
 *  lone `..` never reaches this rule (ISSUE-047 pins it as no path at all). */
const FILE_READING_COMMAND = new Set([
  'get-content', 'gc', 'cat', 'type', 'more', 'head', 'tail', 'less', 'read',
  'get-childitem', 'gci', 'ls', 'dir', 'find', 'stat', 'file',
  'select-string', 'sls', 'findstr', 'rg', 'grep', 'sed', 'awk',
  'get-item', 'gi', 'test-path', 'resolve-path', 'import-csv', 'get-filehash',
]);

const SHELL_BREAK = /[\s;|&(){}<>]/u;
const SHELL_QUOTE = /['"`]/u;
const COMMAND_BREAK = /[\n;|&{}()]/u;

/**
 * Shell words and quoted strings with their spans. A quote that would close on
 * another line is left as text, because a here-string's body is code: the
 * `'../'` inside `@' ... '@` must stay visible to the metacharacter rule, not
 * be swallowed as one literal.
 */
function shellTokens(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (SHELL_BREAK.test(char)) {
      index += 1;
      continue;
    }
    if (SHELL_QUOTE.test(char)) {
      const close = text.indexOf(char, index + 1);
      if (close !== -1 && !text.slice(index + 1, close).includes('\n')) {
        tokens.push({ kind: 'string', start: index, contentStart: index + 1, contentEnd: close });
        index = close + 1;
        continue;
      }
      index += 1;
      continue;
    }
    let end = index;
    while (end < text.length && !SHELL_BREAK.test(text[end]) && !SHELL_QUOTE.test(text[end])) end += 1;
    tokens.push({ kind: 'word', text: text.slice(index, end), start: index });
    index = end;
  }
  return tokens;
}

/**
 * Blank every pattern context in one shell line with spaces, so the path scan
 * sees the line's locations and not its regexes. The rules are positional and
 * fixed:
 *
 *   - the argument of a `PATTERN_WORD`, plus the comma-separated operands after
 *     it (`-replace 'a','b'` blanks both);
 *   - a literal assigned to a `PATTERN_VARIABLE`, directly or through a cast:
 *     `$rx = '...'`, `$pattern = "..."`, `$rx = [regex]'...'`.
 *
 * Nothing else is masked: a quoted literal in `Get-Content '../secrets.txt'`
 * survives, and so does a wildcard argument to `Get-ChildItem`.
 * @param {string} text - a shell command line
 * @returns {string} the same line with pattern contexts replaced by spaces
 */
function maskPatternContexts(text) {
  const chars = text.split('');
  const tokens = shellTokens(text);
  let operand = false;
  let comma = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    let mask = false;
    if (operand) {
      mask = true;
      operand = false;
      comma = true;
    } else if (comma) {
      if (token.kind === 'word' && token.text === ',') {
        operand = true;
      }
      comma = false;
    } else if (previous !== undefined && previous.kind === 'word' && PATTERN_WORD.test(previous.text)) {
      mask = true;
      comma = true;
    } else if (previous !== undefined && previous.kind === 'word' && previous.text === '='
      && tokens[index - 2] !== undefined && tokens[index - 2].kind === 'word'
      && PATTERN_VARIABLE.test(tokens[index - 2].text)) {
      mask = true;
    }
    if (!mask) continue;
    const from = token.kind === 'string' ? token.contentStart : token.start;
    const to = token.kind === 'string' ? token.contentEnd : token.start + token.text.length;
    for (let at = from; at < to; at += 1) chars[at] = ' ';
  }
  return chars.join('');
}

/**
 * The command word that owns the token at `index`: the first word after the
 * last command break, skipping an assignment prefix (`$x = Get-ChildItem ...`).
 * `''` when the token starts a segment.
 */
function commandWordAt(text, index) {
  let start = index;
  while (start > 0 && !COMMAND_BREAK.test(text[start - 1])) start -= 1;
  let head = text.slice(start, index);
  for (;;) {
    const assignment = /^\s*\$[A-Za-z_][\w:]*\s*=\s*/u.exec(head);
    if (assignment === null) break;
    head = head.slice(assignment[0].length);
  }
  const word = /^\S+/u.exec(head.trimStart());
  if (word === null) return '';
  return word[0].replace(/^["'`]+|["'`]+$/gu, '').split(/[\\/]/u).pop()
    .replace(/\.exe$/iu, '').toLowerCase();
}

/**
 * Argument keys whose string value a tool can actually REACH: the target of a
 * read/write, or a shell command line. `new_string` / `content` / `old_string`
 * are payload — document text the brief asks the arm to write (ISSUE-047) — and
 * a path named inside them is prose, not a location the call touches.
 *
 * A path argument is one path by construction (spaces included); a `command` is
 * a shell line whose tokens end at whitespace. `cd` is the `working_directory`
 * tool's target directory — the same reach the old scan gave it.
 */
const PATH_KEYS = new Set(['file_path', 'path', 'notebook_path', 'cd']);
const SHELL_KEYS = new Set(['command']);

/**
 * Reachable strings of a tool input, each flagged as shell text or a whole
 * path. A bare string input is an unparseable argument string — text the model
 * wrote into a call — and is scanned as shell text.
 */
function targetTexts(value, shell = true, out = []) {
  if (typeof value === 'string') out.push({ text: value, shell });
  else if (Array.isArray(value)) for (const item of value) targetTexts(item, shell, out);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (SHELL_KEYS.has(key)) targetTexts(item, true, out);
      else if (PATH_KEYS.has(key)) targetTexts(item, false, out);
    }
  }
  return out;
}

/**
 * Paths named by one tool call, as written.
 *
 * Only TARGETS are scanned: a path argument (`file_path`, `path`,
 * `notebook_path`) as one whole path, and a shell command line token by token.
 * A `..`-relative token inside a command means something against the child's
 * cwd, so it is extracted there too — but only when it names something under
 * the parent (`../x`, `..\x`); a token that stops at the separator (`../`)
 * names the parent directory and is not extracted. A bare string input is an unparseable
 * argument string — text the model wrote into a call — and is scanned as shell
 * text. `new_string` / `content` / `old_string` are payload and never scanned
 * (ISSUE-047).
 *
 * A shell token in a pattern context is not a path (2026-11-09 pair-b):
 * `maskPatternContexts` blanks the operand of `[regex]`, `-match`, `-replace`,
 * `-split`, `-like`, `Select-String -Pattern`, `-Filter`/`-Include`/`-Exclude`
 * and a literal assigned to `$rx`/`$re`/`$regex`/`$pattern`. A surviving token
 * that carries a character illegal in a Windows file name (`*`, `?`, `|`) is a
 * wildcard, not a path, unless a file-reading command owns it
 * (`Get-ChildItem ../*` still names the parent). A literal `../secrets.txt`
 * carries none of those characters and still enters the gate.
 * @param {unknown} input - the parsed `tool/call` arguments
 * @returns {string[]}
 */
export function extractPaths(input) {
  const found = [];
  const seen = new Set();
  const add = (candidate, context = null) => {
    const path = tidyPath(candidate);
    if (path === '') return;
    // A token that ends at the separator (`../`, `..\`, `cd ../`) normalizes to
    // the parent directory itself: a directory, no file component, exactly the
    // shape a bare `..` has always been excluded for. In practice it is code
    // text (`s.startswith('../')`), not a read; only a token naming something
    // UNDER the parent (`../x`) is a path this gate judges.
    if (path === '..') return;
    // A URL is not a filesystem path; `http://` would otherwise look absolute.
    if (/^[a-z]+:\/\//iu.test(path)) return;
    // A bare drive (`C:`) names no location, and a lone separator names none.
    if (/^[A-Za-z]:$/u.test(path) || path === '/' || path === '\\') return;
    // A wildcard is a pattern. It is a location only as the argument of a
    // file-reading command, where `../*` really does list the parent.
    if (context !== null && PATTERN_TOKEN_CHARACTER.test(path)
      && !FILE_READING_COMMAND.has(commandWordAt(context.text, context.index))) return;
    if (seen.has(path.toLowerCase())) return;
    seen.add(path.toLowerCase());
    found.push(path);
  };
  for (const { text, shell } of targetTexts(input)) {
    // A path argument is one path, spaces included; a plain relative path is
    // not judged (the old scope: absolute, or a `..` that can leave the cwd).
    if (!shell) {
      if (/^(?:[A-Za-z]:[\\/]|\/|\.\.[\\/])/u.test(text)) add(text);
      continue;
    }
    // Blank the pattern operands first; the mask keeps every offset, so the
    // owning command word is still read from the original line.
    const masked = maskPatternContexts(text);
    for (const match of masked.matchAll(sep === '\\' ? WIN_ABS : POSIX_ABS)) {
      add(tokenOf(match), { text, index: match.index });
    }
    for (const match of masked.matchAll(PARENT_REL)) {
      add(tokenOf(match), { text, index: match.index });
    }
  }
  return found;
}

// ── The git channel ────────────────────────────────────────────────────────
// `git log` names no path, so the path scan above cannot see it, yet git
// resolves `.git` upward from the child's cwd on its own. The 2026-10-28 vanilla
// arm ran `git rev-parse --is-inside-work-tree; git log --oneline -3` from a
// world with no `.git`; the campaign root has none either (it sits under a
// gitignored `scratchpad/`), so git climbed into this repository and returned
// commit subjects — content from above every declared root, invisible until now.

/** Sub-commands that READ repository content. `commit`, `push`, `checkout` are not reads. */
const GIT_READ_VERB = /^(?:log|show|diff|shortlog|remote|rev-parse|status|blame|describe|reflog)$/iu;
/** Global options whose VALUE is the next token (`git -C <dir> log`). */
const GIT_VALUE_OPTION = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']);
/** Global options that NAME the repository, so git never climbs to find one. `-C`
 *  is NOT among them: it only changes the child's directory, and `git -C <world>
 *  log` climbs above the world exactly as `git log` does. */
const GIT_REPO_OPTION = /^(?:--git-dir|--work-tree)(?:=|$)/u;

/**
 * Each `git` invocation in one shell line: its sub-command and whether the line
 * already names the repository. A quoted absolute path to `git.exe` counts: the
 * basename is what runs. Tokens are split on shell punctuation, so `a; git log`
 * and `git log | head` both yield `log`.
 *
 * `-C <dir>` / `--git-dir` / `--work-tree` pin the repository, so such a call
 * cannot resolve upward; its directory is a visible path the scan already judges.
 * @param {string} text - a shell command line (one `command` argument)
 * @returns {{verb: string, pinned: boolean}[]} one entry per git invocation; the
 *          token after the global options, `''` when the line ends at one
 */
export function gitSubcommands(text) {
  const tokens = text.split(/[\s;&|()<>"'`]+/u).filter((token) => token !== '');
  const invocations = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const base = tokens[index].split(/[\\/]/u).pop().toLowerCase();
    if (base !== 'git' && base !== 'git.exe') continue;
    let cursor = index + 1;
    let verb = '';
    let pinned = false;
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (GIT_REPO_OPTION.test(token)) pinned = true;
      if (GIT_VALUE_OPTION.has(token)) { cursor += 2; continue; }
      if (token.startsWith('-')) { cursor += 1; continue; }
      verb = token;
      break;
    }
    invocations.push({ verb, pinned });
  }
  return invocations;
}

/**
 * Whether a `git` call from `dir` can resolve to a repository at or above
 * `campaignRoot`. A `.git` in the world stops resolution inside the arm's own
 * material; one at the campaign root stops it inside the campaign. Only when
 * neither exists does git climb past every declared root — the leak this row
 * exists to name, because no path rule can name content that has no path.
 *
 * A `.git` file counts as well as a directory (a worktree or submodule pointer
 * is a repository boundary too); `exists` is injectable for the tests.
 * @param {{from: string, campaignRoot: string, exists?: (path: string) => boolean}} input
 * @returns {boolean} true when resolution leaves the declared roots
 */
export function gitResolvesAbove({ from, campaignRoot, exists = existsSync }) {
  let dir = resolve(from);
  const stop = resolve(campaignRoot);
  for (let guard = 0; guard < 128; guard += 1) {
    if (exists(join(dir, '.git'))) return false;
    if (samePath(dir, stop) || !inside(stop, dir)) return true;
    const parent = dirname(dir);
    if (samePath(parent, dir)) return true;
    dir = parent;
  }
  return true;
}

/** Tools whose whole effect is writing a path. An allow-listed root is READ-only
 * (`bench-brief-035.md`: the template checkout may be read and must not be
 * written), so a mutator naming one is a violation, not a permitted read. */
const MUTATING_TOOLS = new Set(['write', 'edit', 'multi_edit', 'str_replace', 'apply_patch', 'notebook_edit']);

/** The call a `tool/result` answers, by any id dsh's log carries. */
function resultCallIdOf(event) {
  const id = event?.data?.toolCallId ?? event?.data?.callId ?? event?.data?.message?.source?.callId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** A host denial marker: a refused call, a blocked path. */
const DENIAL = /denied|refused|blocked|forbidden|not-permitted/u;

/**
 * The denial a `tool/result` states, as the host's own status or code, or
 * `null` (ISSUE-523 item 6). Only an explicit denial marker counts: an ordinary
 * tool error (a missing file, a non-zero exit) is not a boundary fact.
 */
function denialOf(event) {
  const data = event?.data ?? {};
  const message = data.message ?? {};
  for (const value of [data.status, message.status, data.denial, message.denial,
    data.code, message.code, data.wireCode, message.wireCode]) {
    if (typeof value === 'string' && DENIAL.test(value)) return value;
  }
  return null;
}

/**
 * Classify every `tool/call` in a session log against the arm's world.
 *
 * - `judged`    — the number of paths classified. It sits beside `inside`
 *                 because `inside: 0` alone cannot distinguish "nothing
 *                 violated" from "nothing checked".
 * - `evidence-path` — a `violations` row under `evidenceDir`: the harness's own
 *                 output (session log, journal, ledger, blobs). A tool call
 *                 naming it is a violation even when the directory sits inside
 *                 a world root; a world root nested inside it (the dry-work copy
 *                 at `<evidence>/work`, the child's cwd) is exempt. The mount's
 *                 own writes are not tool calls and never enter this scan.
 * - `inside`    — under one of `worldRoots` (the arm tree, its work copy) and
 *                 not under `evidenceDir`.
 * - `allowed`   — under `scratch` (read-write: the OS temp dir) or a READ under
 *                 one of `allow` (`--allow-read`, or `--allow-tool-root`, the
 *                 deps-only interpreter the work needs; ISSUE-297). An
 *                 allow-listed operator path is READ-only (`bench-brief-035.md`:
 *                 the template checkout may be read and must not be written), so
 *                 a mutating tool naming one is a `violations` row instead.
 * - `violations`— a path naming `evidenceDir` (`scope: 'evidence-path'`), a path
 *                 inside the campaign tree but outside the world
 *                 (`scope: 'campaign'`), or a call whose `tool/result` states a
 *                 deny (`scope: 'denied'`, `status` naming the host's marker):
 *                 another arm's evidence, `derive-*.json`, `build/`,
 *                 `VERDICT.md`, a refused or redirected read. The run fails and
 *                 names the call.
 * - `outside`   — anywhere else on the machine; recorded, not gated.
 * - `gitChannel`— a `git` read sub-command whose repository resolution can climb
 *                 past every declared root. Recorded, not gated: the content it
 *                 returns lives outside the campaign, which is the recorded-
 *                 evidence line, and the row exists so a verdict can see it.
 *
 * @param {{sessionEvents: object[], workDir: string, worldRoots: string[],
 *          campaignRoot: string, evidenceDir?: string|null, allow?: string[],
 *          scratch?: string[], exists?: (path: string) => boolean}} input
 * @returns {{judged: number, inside: number, allowed: number,
 *            violations: object[], outside: object[], gitChannel: object[]}}
 */
export function classifyToolCalls({
  sessionEvents, workDir, worldRoots, campaignRoot, allow = [], scratch = defaultAllow(),
  evidenceDir = null, exists = existsSync,
}) {
  const report = { judged: 0, inside: 0, allowed: 0, violations: [], outside: [], gitChannel: [] };
  // ISSUE-523 item 6: pair each call with its `tool/result`. A denied read or a
  // redirected path is a fact only the result carries, and nothing in dsh
  // 0.2.x emits one, so this map is empty on every current run.
  const resultsByCall = new Map();
  for (const event of sessionEvents) {
    if (event?.type !== 'tool/result') continue;
    const callId = resultCallIdOf(event);
    if (callId !== null && !resultsByCall.has(callId)) resultsByCall.set(callId, event);
  }
  // The climb is a property of the world, not of the call, so it is decided
  // once. `workDir` is where the child actually runs.
  const climbs = gitResolvesAbove({ from: workDir, campaignRoot, exists });
  for (const event of sessionEvents) {
    if (event?.type !== 'tool/call') continue;
    const tool = String(event.data?.name ?? 'unknown');
    const callId = String(event.data?.callId ?? '');
    const seq = typeof event.seq === 'number' ? event.seq : null;
    const mutates = MUTATING_TOOLS.has(tool);
    let parsed;
    try {
      parsed = typeof event.data?.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data?.arguments;
    } catch {
      // An unparseable argument string is still text the model wrote; scan it raw.
      parsed = typeof event.data?.arguments === 'string' ? event.data.arguments : null;
    }
    const paths = extractPaths(parsed);
    let firstResolved = null;
    if (climbs) {
      // One row per CALL, so the count reads as `N call(s)`. A call may run
      // several git sub-commands (`rev-parse; log`); the verbs are listed.
      const verbs = [];
      let command = '';
      for (const { text, shell } of targetTexts(parsed)) {
        if (!shell) continue;
        for (const { verb, pinned } of gitSubcommands(text)) {
          if (pinned || !GIT_READ_VERB.test(verb)) continue;
          if (verbs.length === 0) command = text.trim().split(/\r?\n/u)[0];
          verbs.push(verb.toLowerCase());
        }
      }
      if (verbs.length > 0) report.gitChannel.push({ tool, callId, seq, verbs, command });
    }
    for (const path of paths) {
      const absolute = isAbsolute(path) ? resolve(path) : resolve(workDir, path);
      if (firstResolved === null) firstResolved = absolute;
      report.judged += 1;
      // The evidence dir is the harness's own output and may sit inside the
      // world (`--world` puts it at <world>/evidence). A tool call naming it is
      // judged before the world-root check, or that containment would hide it.
      // The dry-work copy is the exception: it lives at <evidence>/work and is
      // the child's cwd, so a world root nested inside the evidence dir is that
      // copy, not harness output.
      if (evidenceDir !== null && inside(evidenceDir, absolute)) {
        const nestedWorld = worldRoots.some((root) => !samePath(root, evidenceDir)
          && inside(evidenceDir, root) && inside(root, absolute));
        if (!nestedWorld) {
          report.violations.push({ tool, callId, seq, path, resolved: absolute, scope: 'evidence-path' });
          continue;
        }
      }
      if (worldRoots.some((root) => inside(root, absolute))) {
        report.inside += 1;
        continue;
      }
      if (scratch.some((root) => inside(root, absolute))) {
        report.allowed += 1;
        continue;
      }
      const allowRoot = allow.find((root) => inside(root, absolute));
      if (allowRoot !== undefined && !mutates) {
        report.allowed += 1;
        continue;
      }
      const row = { tool, callId, seq, path, resolved: absolute };
      if (allowRoot !== undefined) {
        report.violations.push({ ...row, scope: 'read-only', allowedRoot: allowRoot });
      } else if (inside(campaignRoot, absolute)) report.violations.push({ ...row, scope: 'campaign' });
      else report.outside.push(row);
    }
    // A call the host denied is a violation even when its arguments named an
    // allowed path: the host refused what this classifier would have read as
    // clean (ISSUE-523 item 6). One row per call; the path is the first one the
    // call named, or none when the denial names no target. A `tool/result` this
    // build does not pair (no call id) classifies nothing, as before.
    const denial = denialOf(resultsByCall.get(callId));
    if (denial !== null) {
      report.violations.push({ tool, callId, seq,
        path: paths[0] ?? null,
        ...(firstResolved === null ? {} : { resolved: firstResolved }),
        scope: 'denied', status: denial });
    }
  }
  return report;
}

/** The default allow-list: the OS temp dir (scratch space, not bench material). */
export function defaultAllow() {
  return [tmpdir()];
}

/** One-line rendering of a violation, for stderr and the assertion detail. */
export function describeViolation(row) {
  const scope = row.scope === 'read-only'
    ? ` (a write under read-only ${row.allowedRoot})`
    : row.scope === 'campaign' ? ' (inside the campaign, outside the world)'
      : row.scope === 'evidence-path' ? ' (the evidence dir: harness output, not a tool target)'
        : row.scope === 'denied' ? ` (the host denied it: ${String(row.status)})` : '';
  return `${row.tool} call${row.seq === null ? '' : ` seq ${String(row.seq)}`}`
    + ` named ${row.path === null || row.path === undefined ? 'no path' : row.path}${scope}`;
}
