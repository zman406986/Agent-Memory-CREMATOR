#!/usr/bin/env node
/**
 * Bench material: freeze one still image of a source repo into two byte-identical arms.
 *
 * Usage:
 *   node dev/bench/prep.mjs <--sibling <template>|--no-sibling> [--src <repo>]
 *                           [--root <bench-root>] [--dry-run] [--force]
 *
 *   --src      source checkout (default C:/Users/TZhen/Desktop/Taskworld-Project)
 *   --sibling  the template checkout the arms cite; REQUIRED, no default: name
 *              the frozen copy, C:/Users/TZhen/Desktop/racoons-bench/
 *              _sibling-parked-2026-10-27 — never the drifted live
 *              C:/Users/TZhen/Desktop/miliastra-game-template checkout
 *              (ISSUE-090). Frozen beside the arms under the same exclusion law
 *              and hashed into both manifests; its hash must match the pin in
 *              dev/bench/manifests/2026-10-23-taskworld.manifest.json, or the
 *              run is refused with both digests. `--no-sibling` scans and
 *              writes the arms only (the collection step re-scans one finished
 *              arm and has no sibling to freeze).
 *   --root     material root (default C:/Users/TZhen/Desktop/racoons-bench/2026-10-23-taskworld)
 *   --dry-run  scan + hash + report only; writes nothing
 *   --force    replace the three destinations that already exist; never a
 *              general "yes" to a root that holds someone else's material
 *
 * Second device: C:/Users/TZ/Desktop/Taskworld-Project and
 * C:/Users/TZ/Desktop/racoons-bench/_sibling-parked-2026-10-27 (the same frozen
 * copy; the live template checkout is never the sibling), with the root
 * C:/Users/TZ/Desktop/racoons-bench/2026-10-23-taskworld.
 *
 * What it writes, and nothing else:
 *   <root>/racoons-arm/            the copied working tree
 *   <root>/racoons-arm/manifest.json
 *   <root>/vanilla-arm/            the same bytes, copied a second time
 *   <root>/vanilla-arm/manifest.json
 *   <root>/miliastra-game-template/  the frozen sibling, copied once
 *
 * A root that already holds content is refused before anything is written:
 * material lives outside both repos and may be another campaign's. `--force`
 * replaces only the three destinations named above and reports whatever else
 * the root still holds.
 *
 * Both manifests carry the source HEAD, the wall-clock time, every included
 * file's relative path + sha256, the totals, the exact exclusion list with the
 * bytes each entry dropped, and the equality proof. The equality proof is a
 * multiset of `sha256  path` lines: two arms match only when the two sorted
 * line lists are byte-equal. A re-hash of each written arm (not just the
 * source) proves the copy itself, so a truncated write cannot pass.
 *
 * Re-scanning a frozen arm is the collection step: `--dry-run --src <arm>`
 * prints that arm's included count and multiset digest, which the reviewer
 * compares with the pre-run manifest. A root `manifest.json` is never counted
 * as content, and a tree with no `.git` is scanned with `head: null` instead of
 * being refused.
 *
 * The exclusion list was confirmed by a size scan on 2026-10-22 (see
 * rules-inventory.md and the runbook): `.git/`, `node_modules/`, `wheels/`,
 * build output, disposable scratchpad trees, and any single file over 5 MiB.
 * The 5 MiB rule alone drops 3 files / 36.6 MiB; `node_modules` drops 45 MiB
 * (278 of them tracked in the source repo). No `wheels/` directory exists in
 * Taskworld-Project at all; the owner's `wheels` live in the template's
 * `scratchpad/`. The sibling scan added the Python environment names on
 * 2026-10-23: the template's `.venv` holds 21113 installed files, and its
 * `build/` holds 1.5 GiB. A Python environment is an installed-dependency
 * directory, the same category the ticket names for `node_modules`.
 *
 * Plain Node >= 22, no dependencies. Exit 0 = two arms written and equal,
 * sibling frozen under the same exclusion law; 1 = identity or copy check
 * failed; 2 = bad arguments or an existing arm.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';
import { inside, samePath } from '../shared/paths.mjs';

const DEFAULTS = Object.freeze({
  src: 'C:/Users/TZhen/Desktop/Taskworld-Project',
  root: 'C:/Users/TZhen/Desktop/racoons-bench/2026-10-23-taskworld',
});
/** The round manifest carrying the sibling pin this script checks against. */
const PIN_MANIFEST = fileURLToPath(
  new URL('./manifests/2026-10-23-taskworld.manifest.json', import.meta.url),
);
const ARMS = Object.freeze(['racoons-arm', 'vanilla-arm']);
/** The frozen sibling directory name; the repo law's one relative citation. */
const SIBLING_DIR = 'miliastra-game-template';
const MANIFEST_NAME = 'manifest.json';
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Directory names dropped wherever they appear. `reason` is printed, so the
 * report says why a subtree is absent from the arms.
 */
const EXCLUDED_DIR_NAMES = new Map([
  ['.git', 'vcs history, named by the ticket'],
  ['node_modules', 'installed dependencies, named by the ticket'],
  ['wheels', 'vendor wheel cache, named by the ticket'],
  // A Python virtual environment is `node_modules` under another name: the
  // template's `.venv` alone holds 21113 installed files.
  ['.venv', 'installed dependencies (python environment)'],
  ['venv', 'installed dependencies (python environment)'],
  ['.tox', 'installed dependencies (python environment)'],
  ['build', 'build output (gitignored in the source repo)'],
  ['dist', 'build output'],
  ['out', 'build output'],
  ['target', 'build output'],
  ['scratchpad', 'disposable by the source repo law; never cited'],
  ['.worktrees', 'parallel-team checkouts'],
  ['.workbuddy', 'local agent state'],
  ['.opencode', 'local agent state'],
  ['.local', 'local state'],
  ['__pycache__', 'python cache'],
  ['.pytest_cache', 'python cache'],
  ['.mypy_cache', 'python cache'],
  ['.ruff_cache', 'python cache'],
]);

/** Manifest schema tag; bump when the shape changes. */
const SCHEMA = 'racoons-bench-arm/1';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const PREP_OPTIONS = optionsOf([
  ['--src', 'string'],
  ['--sibling', 'string'],
  ['--no-sibling', 'boolean'],
  ['--root', 'string'],
  ['--dry-run', 'boolean', 'dryRun'],
  ['--force', 'boolean'],
]);

function parseArgs(argv) {
  // No sibling default: the live template checkout has drifted from the round's
  // pin, so naming the one to freeze is the caller's job (ISSUE-090).
  const { values, order } = parseDevArgs(argv, {
    options: PREP_OPTIONS,
    refuse: fail,
    help: 'usage: prep.mjs <--sibling <template>|--no-sibling> [--src <repo>] '
      + '[--root <bench-root>] [--dry-run] [--force]\n'
      + '--sibling is required and has no default: name the frozen copy '
      + '(…/racoons-bench/_sibling-parked-2026-10-27), never the live template checkout\n',
  });
  // `--sibling` and `--no-sibling` write one field; the later one wins, as the
  // switch let it. `undefined` (neither given) is distinct from `null`
  // (`--no-sibling`), which is what the required-check below keys on.
  const siblingAt = order.lastIndexOf('sibling');
  const noSiblingAt = order.lastIndexOf('no-sibling');
  let sibling = values.sibling;
  if (noSiblingAt > siblingAt) sibling = null;
  const opts = {
    src: values.src ?? DEFAULTS.src,
    sibling,
    root: values.root ?? DEFAULTS.root,
    dryRun: values.dryRun ?? false,
    force: values.force ?? false,
  };
  if (opts.sibling === undefined) {
    fail('prep.mjs: --sibling is required (name the frozen template copy, e.g. '
      + 'C:/Users/TZhen/Desktop/racoons-bench/_sibling-parked-2026-10-27); '
      + 'pass --no-sibling to freeze the arms only. There is no default: the live '
      + 'C:/Users/TZhen/Desktop/miliastra-game-template checkout has drifted from the round pin');
  }
  opts.src = resolve(opts.src);
  opts.root = resolve(opts.root);
  if (opts.sibling !== null) opts.sibling = resolve(opts.sibling);
  return opts;
}

/** POSIX-style relative path, the only spelling a manifest carries. */
function toPosix(root, full) {
  return relative(root, full).split(sep).join('/');
}

function sha256File(full) {
  return createHash('sha256').update(readFileSync(full)).digest('hex');
}

/**
 * Walk one tree under the exclusion law. Returns included files (path, bytes,
 * sha256), the excluded directories with the bytes/files they held, and the
 * oversize files with their sizes.
 *
 * @param {string} src absolute source root
 * @param {boolean} hash false for the size-only pass
 */
function scan(src, hash) {
  const files = [];
  const excludedDirs = [];
  const oversize = [];
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const reason = EXCLUDED_DIR_NAMES.get(entry.name);
        if (reason !== undefined) {
          const measured = measure(full);
          excludedDirs.push({
            path: toPosix(src, full),
            bytes: measured.bytes,
            files: measured.files,
            reason,
          });
          continue;
        }
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks and devices are never copied
      // The arm's own manifest is metadata about the tree, never tree content:
      // a post-run scan of an arm must compare like with like.
      if (dir === src && entry.name === MANIFEST_NAME) continue;
      const size = statSync(full).size;
      if (size > MAX_BYTES) {
        oversize.push({ path: toPosix(src, full), bytes: size, limitBytes: MAX_BYTES, reason: 'larger than 5 MiB' });
        continue;
      }
      files.push({
        path: toPosix(src, full),
        bytes: size,
        ...(hash ? { sha256: sha256File(full) } : {}),
      });
    }
  };
  walk(src);
  return { files, excludedDirs, oversize };
}

/** Recursive size of a tree, used only to report what an exclusion drops. */
function measure(dir) {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = measure(full);
      bytes += inner.bytes;
      files += inner.files;
    } else if (entry.isFile()) {
      bytes += statSync(full).size;
      files += 1;
    }
  }
  return { bytes, files };
}

function git(src, args) {
  const run = spawnSync('git', ['-C', src, ...args], { encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) fail(`prep.mjs: git ${args.join(' ')} failed: ${(run.stderr ?? '').trim()}`);
  return run.stdout.trim();
}

/** Copy one file, creating its parent. Bytes are copied, never re-encoded. */
function copyOne(srcRoot, destRoot, rel) {
  const from = join(srcRoot, ...rel.split('/'));
  const to = join(destRoot, ...rel.split('/'));
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

/**
 * The identity key: sorted `sha256  path` lines. Two arms are byte-identical
 * exactly when these strings are equal.
 */
function multiset(files) {
  return files.map((file) => `${file.sha256}  ${file.path}`).sort().join('\n');
}

function multisetDigest(files) {
  return createHash('sha256').update(multiset(files)).digest('hex');
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function reportScan(scanResult) {
  const out = [];
  out.push(`included: ${scanResult.files.length} file(s), ${formatBytes(scanResult.files.reduce((sum, f) => sum + f.bytes, 0))}`);
  out.push(`excluded directories (${scanResult.excludedDirs.length}):`);
  for (const entry of scanResult.excludedDirs) {
    out.push(`  ${entry.path}  ${formatBytes(entry.bytes)}  ${entry.files} file(s)  [${entry.reason}]`);
  }
  out.push(`oversize files (> ${formatBytes(MAX_BYTES)}, dropped): ${scanResult.oversize.length}`);
  for (const entry of scanResult.oversize) {
    out.push(`  ${entry.path}  ${formatBytes(entry.bytes)}`);
  }
  return out.join('\n');
}

/**
 * Refuse a sibling that is not the bytes the round pinned (ISSUE-090). The
 * expected values come from a file outside this run — the frozen manifest —
 * so a drifted checkout, passed by hand or by an old default, cannot reach a
 * new manifest. A manifest stating no sibling pin is reported, never assumed
 * green.
 *
 * @param {{files: {bytes: number, sha256: string, path: string}[]}} sibling the scan about to be frozen
 * @param {string} siblingPath the checkout that scan came from, named in the refusal
 */
function checkSiblingPin(sibling, siblingPath) {
  if (!existsSync(PIN_MANIFEST)) {
    fail(`prep.mjs: sibling pin manifest not found at ${PIN_MANIFEST}; the sibling cannot be checked against the round`);
  }
  const pin = JSON.parse(readFileSync(PIN_MANIFEST, 'utf8'))?.sibling?.totals;
  if (pin === undefined || typeof pin.multisetSha256 !== 'string') {
    process.stdout.write(`sibling pin: ${PIN_MANIFEST} states no sibling totals; nothing to compare\n`);
    return;
  }
  const actualFiles = sibling.files.length;
  const actualDigest = multisetDigest(sibling.files);
  if (pin.multisetSha256 === actualDigest && pin.files === actualFiles) {
    process.stdout.write(`sibling pin: PASS ${actualDigest} over ${actualFiles} file(s) `
      + `(pin from ${PIN_MANIFEST})\n`);
    return;
  }
  fail(`prep.mjs: sibling does not match the round pin in ${PIN_MANIFEST}\n`
    + `  expected ${pin.multisetSha256} over ${pin.files} file(s)\n`
    + `  actual   ${actualDigest} over ${actualFiles} file(s)\n`
    + `  at ${siblingPath}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.src)) fail(`prep.mjs: source not found at ${opts.src}`);
  if (opts.sibling !== null && !existsSync(opts.sibling)) {
    fail(`prep.mjs: sibling not found at ${opts.sibling}; pass --sibling <template> (the arms must cite a frozen copy)`);
  }
  const destinations = opts.sibling === null ? [...ARMS] : [...ARMS, SIBLING_DIR];

  // A root that already holds content belongs to someone else until proven
  // otherwise: another campaign, a half-run, a hand-made directory. Refuse
  // before writing anything and name what is there, so the operator can
  // confirm the root is ours before re-running with --force. A dry run writes
  // nothing, so it skips this gate: `--dry-run --src <arm>` is the collection
  // step and must work while the campaign root is full.
  if (existsSync(opts.root) && !opts.dryRun) {
    if (!statSync(opts.root).isDirectory()) fail(`prep.mjs: --root ${opts.root} exists and is not a directory`);
    const present = readdirSync(opts.root);
    const ours = new Set(destinations);
    if (present.length > 0 && !opts.force) {
      fail(`prep.mjs: ${opts.root} already holds content (${present.join(', ')}); `
        + 'confirm it is this bench campaign\'s root, then pass --force');
    }
    const foreign = present.filter((name) => !ours.has(name));
    if (foreign.length > 0) {
      fail(`prep.mjs: ${opts.root} holds entries this script never writes (${foreign.join(', ')}); `
        + 'refusing to replace a root that is not ours');
    }
  }

  // A frozen arm has no `.git`; scanning one is the collection step, so a
  // missing history is recorded as null rather than refused. Writing a new arm
  // from a historyless tree is allowed too — the manifest says so.
  const isCheckout = existsSync(join(opts.src, '.git'));
  const head = isCheckout ? git(opts.src, ['rev-parse', 'HEAD']) : null;
  const dirty = isCheckout
    ? git(opts.src, ['status', '--porcelain']).split(/\r?\n/u).filter((line) => line !== '')
    : [];

  // A material root inside the source (or the reverse) would copy an arm into
  // the next arm's scan and make identity meaningless. The sibling gets the
  // same test: freezing it inside itself is a loop, not a copy. A dry run
  // writes nothing, so the guard is lifted there: re-scanning a finished arm in
  // place (`--dry-run --src <arm>`) is the collection step.
  // Containment is decided on the resolved path by the shared helper, so a case,
  // drive or `..` variant cannot slip past a string compare; the same path is
  // not "one contains the other", so it is excluded explicitly.
  const contains = (outer, inner) => inside(outer, inner) && !samePath(outer, inner);
  if (!opts.dryRun) {
    const containers = [['src', opts.src], ...opts.sibling === null ? [] : [['sibling', opts.sibling]]];
    for (const [name, path] of containers) {
      if (contains(path, opts.root) || contains(opts.root, path)) {
        fail(`prep.mjs: --root (${opts.root}) and --${name} (${path}) must not contain one another`);
      }
    }
  }

  process.stdout.write(`source ${opts.src}\nHEAD   ${head ?? '<no .git; a frozen arm>'}
dirty  ${dirty.length} path(s) (the working tree is the image, committed or not)\n`);
  if (dirty.length > 0) {
    for (const line of dirty.slice(0, 20)) process.stdout.write(`  ${line}\n`);
    if (dirty.length > 20) process.stdout.write(`  … ${dirty.length - 20} more\n`);
  }

  const first = scan(opts.src, true);
  process.stdout.write(`${reportScan(first)}\n`);

  // The sibling is frozen under the same exclusion law, so the reviewer sees
  // exactly the template bytes the arms could read.
  const sibling = opts.sibling === null ? null : scan(opts.sibling, true);
  const siblingHead = opts.sibling === null ? null
    : existsSync(join(opts.sibling, '.git')) ? git(opts.sibling, ['rev-parse', 'HEAD']) : null;
  const siblingDirty = opts.sibling === null ? []
    : existsSync(join(opts.sibling, '.git'))
      ? git(opts.sibling, ['status', '--porcelain']).split(/\r?\n/u).filter((line) => line !== '')
      : [];
  if (sibling !== null) {
    process.stdout.write(`\nsibling ${opts.sibling}\nHEAD    ${siblingHead ?? '<no .git>'}\n`);
    process.stdout.write(`sibling ${reportScan(sibling).split('\n').join('\nsibling ')}\n`);
    checkSiblingPin(sibling, opts.sibling);
  }

  if (opts.dryRun) {
    process.stdout.write('DRY RUN: nothing written\n');
    process.stdout.write(`would write ${destinations.map((name) => join(opts.root, name)).join(' and ')}\n`);
    process.stdout.write(`identity multiset ${multisetDigest(first.files)} over ${first.files.length} file(s)\n`);
    if (sibling !== null) {
      process.stdout.write(`sibling multiset ${multisetDigest(sibling.files)} over ${sibling.files.length} file(s)\n`);
    }
    return;
  }

  for (const name of destinations) {
    const dest = join(opts.root, name);
    if (existsSync(dest) && !opts.force) {
      fail(`prep.mjs: ${dest} exists; pass --force to replace it (an arm is a still image, never a merge target)`);
    }
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
  }

  const materializedAt = new Date().toISOString();
  const manifests = new Map();
  let copyFailed = false;

  /**
   * Copy one scanned tree and re-hash what landed on disk. The manifest
   * describes the destination, not the source, so a truncated write cannot pass.
   * @param {string} fromRoot
   * @param {string} destRoot
   * @param {{path: string, bytes: number, sha256: string}[]} expectedFiles
   * @param {string} label
   * @returns {{path: string, bytes: number, sha256: string}[]} the written files
   */
  const copyAndVerify = (fromRoot, destRoot, expectedFiles, label) => {
    for (const file of expectedFiles) copyOne(fromRoot, destRoot, file.path);
    const written = scan(destRoot, true);
    const expected = new Map(expectedFiles.map((file) => [file.path, file]));
    const mismatches = [];
    for (const file of written.files) {
      const want = expected.get(file.path);
      if (want === undefined) mismatches.push(`${file.path}: extra file in ${label}`);
      else if (want.sha256 !== file.sha256) mismatches.push(`${file.path}: sha256 differs after copy`);
      else if (want.bytes !== file.bytes) mismatches.push(`${file.path}: byte count differs after copy`);
    }
    const seen = new Set(written.files.map((file) => file.path));
    for (const file of expectedFiles) if (!seen.has(file.path)) mismatches.push(`${file.path}: missing from ${label}`);
    if (mismatches.length > 0) {
      copyFailed = true;
      process.stderr.write(`COPY FAIL ${label}:\n${mismatches.map((line) => `  ${line}`).join('\n')}\n`);
    }
    return written.files;
  };

  const siblingWritten = opts.sibling === null ? null
    : copyAndVerify(opts.sibling, join(opts.root, SIBLING_DIR), sibling.files, SIBLING_DIR);
  const siblingTotals = siblingWritten === null ? null
    : {
      files: siblingWritten.length,
      bytes: siblingWritten.reduce((sum, file) => sum + file.bytes, 0),
      multisetSha256: multisetDigest(siblingWritten),
    };

  for (const arm of ARMS) {
    const dest = join(opts.root, arm);
    const writtenFiles = copyAndVerify(opts.src, dest, first.files, arm);
    manifests.set(arm, {
      schema: SCHEMA,
      arm,
      source: {
        path: opts.src,
        head,
        dirtyPaths: dirty,
      },
      // The frozen sibling the arms may cite: same path relative to the arm
      // root on every device, hashed so a template that moved mid-campaign is
      // visible in the evidence. Absent only when the caller wrote `--no-sibling`.
      sibling: siblingTotals === null ? null : {
        path: join(opts.root, SIBLING_DIR),
        source: { path: opts.sibling, head: siblingHead, dirtyPaths: siblingDirty },
        totals: siblingTotals,
      },
      materializedAt,
      exclusions: {
        directoryNames: [...EXCLUDED_DIR_NAMES.keys()],
        directories: first.excludedDirs,
        oversizeFiles: first.oversize,
        oversizeLimitBytes: MAX_BYTES,
      },
      totals: {
        files: writtenFiles.length,
        bytes: writtenFiles.reduce((sum, file) => sum + file.bytes, 0),
        multisetSha256: multisetDigest(writtenFiles),
      },
      files: writtenFiles,
    });
  }

  const a = manifests.get(ARMS[0]);
  const b = manifests.get(ARMS[1]);
  const identical = multiset(a.files) === multiset(b.files);
  for (const manifest of manifests.values()) {
    manifest.identity = {
      otherArm: manifest.arm === ARMS[0] ? ARMS[1] : ARMS[0],
      equalsOtherArm: identical,
      multisetSha256: multisetDigest(manifest.files),
    };
    writeFileSync(join(opts.root, manifest.arm, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  process.stdout.write(`\nracoons-arm: ${a.totals.files} file(s), ${a.totals.bytes} byte(s), multiset ${a.totals.multisetSha256}\n`);
  process.stdout.write(`vanilla-arm: ${b.totals.files} file(s), ${b.totals.bytes} byte(s), multiset ${b.totals.multisetSha256}\n`);
  process.stdout.write(`sibling: ${siblingTotals === null ? 'not frozen (--no-sibling)'
    : `${siblingTotals.files} file(s), ${siblingTotals.bytes} byte(s), multiset ${siblingTotals.multisetSha256} (HEAD ${siblingHead ?? '<no .git>'})`}\n`);
  if (!identical) {
    const left = new Map(a.files.map((file) => [file.path, file.sha256]));
    const right = new Map(b.files.map((file) => [file.path, file.sha256]));
    const diff = [];
    for (const [path, hash] of left) {
      if (!right.has(path)) diff.push(`${path}: only in ${ARMS[0]}`);
      else if (right.get(path) !== hash) diff.push(`${path}: sha256 differs between arms`);
    }
    for (const path of right.keys()) if (!left.has(path)) diff.push(`${path}: only in ${ARMS[1]}`);
    process.stderr.write(`IDENTITY FAIL: the two arms differ\n${diff.slice(0, 50).map((line) => `  ${line}`).join('\n')}\n`);
    if (diff.length > 50) process.stderr.write(`  … ${diff.length - 50} more\n`);
    process.exit(1);
  }
  if (copyFailed) {
    process.stderr.write('IDENTITY FAIL: an arm did not match its source scan\n');
    process.exit(1);
  }
  process.stdout.write(`IDENTITY PASS: ${a.totals.files} file(s), ${a.totals.bytes} byte(s), multiset equal in both arms\n`);
  process.stdout.write(`material ${opts.root}\n`);
}

main();
