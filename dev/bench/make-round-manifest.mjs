#!/usr/bin/env node
/**
 * Generate a round manifest (`racoons-bench-round-tasks/1`) for a new brief.
 *
 * Every existing round manifest was hand-authored, and three of its fields are
 * gated on a real launch: `brief.taskSha256`, `brief.taskBlockBytes` and
 * `image.digest` (dev/bench/manifest-gate.mjs:54-81), plus `deliverables.count`
 * (dev/bench/bench-run.mjs manifestDeliverablesGate). A hand-typed digest that
 * disagrees with the brief is caught only when the launch is already paid for,
 * so this tool computes those four fields and refuses to write a file it could
 * not derive.
 *
 * The gate fields are computed from the same code the launcher uses:
 *   - the brief's fenced task block: the same regex and `trim()` as
 *     `readBrief` (dev/bench/bench-run.mjs:1692-1704);
 *   - `taskSha256`: `taskSha256` imported from dev/bench/manifest-gate.mjs;
 *   - `taskBlockBytes`: `task.length`, the CHARACTER count the gate compares
 *     (the field name says bytes; it has always counted characters);
 *   - `image.digest`: the per-arm `manifest.json` `totals.multisetSha256`;
 *   - `deliverables.count`: `deliverablesFromBrief(task, brief)` imported from
 *     dev/bench/dsh-checkpoints.mjs — the call
 *     `resolveBenchDeliverables` makes (dev/bench/bench-run.mjs:1863-1880).
 *     A brief that names no list REFUSES; the thirteen defaults are never
 *     substituted silently.
 *
 * Informational blocks are not invented. `tasks`, `totals`,
 * `windowProjection`, `expectedFiresNote` and `dist` describe a read plan and a
 * measured reservation that only the brief's bound table and a frozen dist
 * tree can supply; the generator omits them and says so in `provenance`
 * instead of emitting empty ones that a reader could mistake for measured
 * zeros. `image`, `imageRoot` and `deliverables` are derived from the arm
 * manifest and the brief.
 *
 * Usage:
 *   node dev/bench/make-round-manifest.mjs --brief <file> \
 *     --arm-manifest <per-arm manifest.json> --round <name> --out <file> \
 *     [--image-root <path>] [--note <text>]
 *
 * `--image-root` defaults to the directory holding `--arm-manifest` (the
 * materialized arm tree, POSIX-slashed), which is what every committed
 * manifest states. `--note` lands in `provenance.note`.
 *
 * Exit codes: 0 written, 2 bad command line or a required fact cannot be
 * derived, 1 an input could not be read.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { manifestTaskGate, taskSha256 } from './manifest-gate.mjs';
import { deliverablesFromBrief } from './dsh-checkpoints.mjs';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';
import { relativeInside } from '../shared/paths.mjs';

const TOOL = 'make-round-manifest';

/** The repo root: this file lives at <repo>/dev/bench/. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The brief's fence block, exactly as `readBrief` in bench-run.mjs reads it. */
export function readBriefTask(file) {
  const text = readFileSync(file, 'utf8');
  const at = text.search(/^## Task text[ \t]*$/mu);
  if (at < 0) fail(`${file} has no "## Task text" heading`);
  const fence = text.slice(at).match(/```[a-z]*\r?\n([\s\S]*?)\r?\n```/u);
  if (fence === null) fail(`${file} has no fenced block under "## Task text"`);
  const task = fence[1].trim();
  if (task === '') fail(`${file} names an empty task`);
  return { task, text };
}

/**
 * The brief's expected deliverable list, or a refusal. The list is resolved by
 * the launcher's own function with the launcher's own arguments (the task fence
 * first, the whole brief as fallback), so the count written here is the count
 * the launch will gate.
 * @param {string} task - the trimmed fence block.
 * @param {string} briefText - the whole brief file.
 * @returns {string[]}
 */
export function deriveDeliverables(task, briefText) {
  const derived = deliverablesFromBrief(task, briefText);
  if (derived === null) {
    fail('the brief names no deliverable list: no explicit file list ends the task fence and no '
      + 'line ending in ":" introduces one, so deliverables.count cannot be derived. '
      + 'The thirteen extended-audit defaults are NOT substituted; add the list to the brief.');
  }
  return derived;
}

/** Forward slashes, no trailing slash. */
function toPosix(value) {
  return String(value).replace(/\\/gu, '/').replace(/\/{2,}/gu, '/').replace(/\/+$/u, '');
}

/** A path expressed from the repo root when it sits inside it, else absolute. */
function repoRelative(file) {
  const absolute = resolve(file);
  const relative = relativeInside(REPO_ROOT, absolute);
  if (relative !== null && relative !== '') return toPosix(relative);
  return toPosix(absolute);
}

/**
 * The arm's image identity out of its per-arm `manifest.json`. The digest is
 * `totals.multisetSha256`, the same value `manifestTaskGate` compares against
 * `image.digest`.
 */
export function readArmManifest(file) {
  const arm = JSON.parse(readFileSync(file, 'utf8'));
  const totals = arm?.totals;
  if (totals === null || typeof totals !== 'object') fail(`${file} has no totals block`);
  const digest = totals.multisetSha256;
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)) {
    fail(`${file}: totals.multisetSha256 is ${JSON.stringify(digest)}, not a sha256 hex digest`);
  }
  if (!Number.isSafeInteger(totals.files) || !Number.isSafeInteger(totals.bytes)) {
    fail(`${file}: totals.files/totals.bytes are not integers, so the image size is unknown`);
  }
  return { arm, digest, files: totals.files, bytes: totals.bytes };
}

/**
 * A one-line source label. A string is used as written; the arm manifest's
 * usual `{path, head, dirtyPaths}` object becomes `<dirname>@<head[0..7]>`.
 * @returns {string|null}
 */
function sourceLabel(source) {
  if (typeof source === 'string' && source.trim() !== '') return source;
  if (source === null || typeof source !== 'object') return null;
  const head = typeof source.head === 'string' && source.head !== '' ? source.head.slice(0, 7) : null;
  const base = typeof source.path === 'string' && source.path !== ''
    ? toPosix(source.path).split('/').at(-1) : null;
  if (base !== null && head !== null) return `${base}@${head}`;
  return base ?? head;
}

/** A note naming the sibling image the arm manifest recorded, or null. */
function siblingNote(sibling) {
  if (sibling === null || typeof sibling !== 'object') return null;
  const totals = sibling.totals;
  if (totals === null || typeof totals !== 'object'
    || typeof totals.multisetSha256 !== 'string') return null;
  const where = typeof sibling.path === 'string' ? ` at ${toPosix(sibling.path)}` : '';
  return `sibling image${where} (files ${String(totals.files)}, bytes ${String(totals.bytes)}); `
    + `sibling multiset pin ${totals.multisetSha256.slice(0, 8)}`;
}

/** The operator's local calendar date, `yyyy-mm-dd`. */
export function localDate(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Build the manifest object. Pure: every input is a path or a string, and
 * `today` is injectable so a test can pin `provenance.derivedAt`.
 *
 * @param {{briefPath: string, armManifestPath: string, round: string,
 *   imageRoot?: string|null, note?: string|null, today?: string}} input
 * @returns {{manifest: object, task: string, paths: string[]}}
 */
export function buildRoundManifest({
  briefPath, armManifestPath, round, imageRoot = null, note = null,
  today = localDate(),
}) {
  const briefFile = resolve(briefPath);
  const armFile = resolve(armManifestPath);
  const { task, text } = readBriefTask(briefFile);
  const sha = taskSha256(task);
  const arm = readArmManifest(armFile);
  const paths = deriveDeliverables(task, text);
  const digest = arm.digest;
  const imageDir = imageRoot === null || imageRoot === undefined
    ? toPosix(dirname(armFile)) : toPosix(imageRoot);

  const source = sourceLabel(arm.arm.source);
  const materialized = typeof arm.arm.materializedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}/u.test(arm.arm.materializedAt)
    ? arm.arm.materializedAt.slice(0, 10) : null;
  const image = {};
  if (source !== null) image.source = source;
  image.digest = digest;
  if (materialized !== null) image.reMaterialized = materialized;
  const sibling = siblingNote(arm.arm.sibling);
  if (sibling !== null) image.note = sibling;
  image.files = arm.files;
  image.bytes = arm.bytes;

  const omitted = 'Omitted informational blocks: tasks, totals, windowProjection, '
    + 'expectedFiresNote and dist. They describe the brief\'s bound table and a measured dist '
    + 'tree, which this generator does not read; no launcher gate reads them '
    + '(dev/bench/manifest-gate.mjs manifestEnforcementRecord).';
  const notes = [];
  if (typeof note === 'string' && note.trim() !== '') {
    const text = note.trim();
    notes.push(/[.!?]$/u.test(text) ? text : `${text}.`);
  }
  notes.push(omitted);

  const manifest = {
    schema: 'racoons-bench-round-tasks/1',
    round,
    brief: {
      path: repoRelative(briefFile),
      taskSha256: sha,
      taskSha256Method: "sha256 over the first fenced block under 'Task text', trimmed "
        + `(dev/bench/manifest-gate.mjs taskSha256); computed ${today} by dev/bench/make-round-manifest.mjs`,
      taskBlockBytes: task.length,
    },
    imageRoot: imageDir,
    image,
    provenance: {
      derivedAt: today,
      generator: 'dev/bench/make-round-manifest.mjs',
      tools: [
        `${repoRelative(briefFile)} (the fenced 'Task text' block: taskSha256 and its character count)`,
        `${repoRelative(armFile)} (image.digest = totals.multisetSha256, plus the image file and byte counts)`,
        'dev/bench/dsh-checkpoints.mjs deliverablesFromBrief over the task fence, the whole brief '
        + 'as fallback (deliverables.count; the same call the launcher makes)',
      ],
      note: notes.join(' '),
    },
    deliverables: {
      count: paths.length,
      source: 'the brief-derived list (dev/bench/dsh-checkpoints.mjs deliverablesFromBrief)',
      note: `The count is the length of the list dev/bench/bench-run.mjs derives from this brief `
        + `(${String(paths.length)} path(s)); manifestDeliverablesGate compares this number to that `
        + 'list at launch, so a brief edited after this file was written fails the launch.',
    },
  };

  // The self-check: the gate the launch applies, run before the file exists.
  const gate = manifestTaskGate({
    manifest, taskSha256: sha, taskChars: task.length, armMultiset: digest,
  });
  if (!gate.ok) fail(`the computed manifest fails manifestTaskGate: ${gate.detail}`);
  return { manifest, task, paths };
}

/** Print the one-line summary the operator reads. */
export function summaryLine({ manifest, out }) {
  const image = manifest.image.digest;
  return `${TOOL}: ${manifest.round} taskSha256 ${manifest.brief.taskSha256.slice(0, 12)} `
    + `block ${String(manifest.brief.taskBlockBytes)} chars image ${image.slice(0, 12)} `
    + `deliverables ${String(manifest.deliverables.count)} -> ${out}`;
}

function fail(message) {
  process.stderr.write(`${TOOL}: ${message}\n`);
  process.exit(2);
}

/** The six string flags, in the order the usage line lists them (ISSUE-381). */
const ROUND_MANIFEST_OPTIONS = optionsOf([
  ['--brief', 'string'], ['--arm-manifest', 'string'], ['--round', 'string'],
  ['--out', 'string'], ['--image-root', 'string'], ['--note', 'string'],
]);

/**
 * Parse via the shared parser, so `--flag=value` works as well as `--flag value`.
 * `fail` already writes the TOOL prefix and exits 2, so no `prefix` is passed:
 * refusals stay single-prefixed and in this script's own words.
 */
export function parseArgs(argv) {
  const opts = { brief: null, armManifest: null, round: null, out: null, imageRoot: null, note: null };
  const { values } = parseDevArgs(argv, { options: ROUND_MANIFEST_OPTIONS, refuse: fail });
  Object.assign(opts, values);
  for (const required of ['brief', 'armManifest', 'round', 'out']) {
    if (opts[required] === null) {
      fail(`--${required === 'armManifest' ? 'arm-manifest' : required} is required`);
    }
  }
  if (opts.round.trim() === '') fail('--round is empty');
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  let built;
  try {
    built = buildRoundManifest({
      briefPath: opts.brief,
      armManifestPath: opts.armManifest,
      round: opts.round,
      imageRoot: opts.imageRoot,
      note: opts.note,
    });
  } catch (error) {
    process.stderr.write(`${TOOL}: ${error.message}\n`);
    process.exit(1);
  }
  const out = resolve(opts.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(built.manifest, null, 2)}\n`);
  process.stdout.write(`${summaryLine({ manifest: built.manifest, out: repoRelative(out) })}\n`);
}

// Run only when this file is the process entry point, so the test can import
// the builders without writing a manifest; the guard mirrors bench-run.mjs.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) main(process.argv.slice(2));
