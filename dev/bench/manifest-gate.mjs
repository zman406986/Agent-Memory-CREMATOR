#!/usr/bin/env node
/**
 * The round-manifest task gate: a stale brief must fail before anything is wiped.
 *
 * `result.json` already records the brief's `taskSha256`, but nothing compared
 * it to the round manifest, so a brief edited after the manifest was written
 * launched silently and the run could only be rejected after the fact. The
 * launcher's `--manifest <path>` names the round manifest and this gate runs on
 * the argument path, before the arm dir is touched.
 *
 * Why its own module: `bench-run.mjs` executes `main()` only when it is the
 * process entry point (the guard at the bottom compares `process.argv[1]` to
 * `import.meta.url`), so importing it assembles nothing; the comparison lives
 * here anyway, pure, so the test pins both directions without spawning a run.
 *
 * Field quirk: the manifest's `taskBlockBytes` counts CHARACTERS of the trimmed
 * fence block, not UTF-8 bytes (the extended brief: 9 329 chars, 9 353 bytes).
 * The gate compares the same quantity the manifest states and says so on a
 * mismatch; renaming the field is the manifest owner's call.
 */
import { createHash } from 'node:crypto';

/**
 * The fence hash exactly as the launcher computes it: sha256 over the trimmed
 * first fenced block, hex. Exported so the launcher and the manifest's
 * `taskSha256Method` cannot drift.
 * @param {string} task - the trimmed fenced task text.
 * @returns {string}
 */
export function taskSha256(task) {
  return createHash('sha256').update(task).digest('hex');
}

/**
 * Compare a round manifest's brief block against this launch's brief.
 *
 * A manifest with no `brief` block (the per-arm `manifest.json` is such a
 * file) states no brief, so the gate skips rather than passing silently: the
 * caller records the skip.
 *
 * The image half rides the same seam: the round manifest's `image.digest` is
 * the arm manifest's `totals.multisetSha256` under another name, so a
 * re-materialized arm whose bytes drifted is caught here, still for free.
 * Both ways the image half can go unexercised are stated, never silent: a
 * manifest that carries a brief but no `image.digest` is a broken manifest and
 * fails (the brief binds an image that is not named), and a readable digest
 * with no arm manifest to hold the multiset is `skipped` with the reason, so
 * the caller prints what it could not compare (fifteenth audit item 2).
 *
 * @param {{manifest: object|null, taskSha256: string, taskChars: number,
 *   armMultiset?: string|null}} input
 * @returns {{ok: boolean, skipped?: string, detail?: string}}
 */
export function manifestTaskGate({ manifest, taskSha256: sha, taskChars, armMultiset = null }) {
  const brief = manifest?.brief;
  if (brief === undefined || brief === null) {
    return { ok: true, skipped: 'the manifest carries no brief block' };
  }
  const problems = [];
  if (typeof brief.taskSha256 !== 'string' || brief.taskSha256 !== sha) {
    problems.push(`task sha256 ${sha} != manifest ${String(brief.taskSha256)}`);
  }
  if (brief.taskBlockBytes !== undefined && brief.taskBlockBytes !== taskChars) {
    problems.push(`task block ${String(taskChars)} chars != manifest taskBlockBytes `
      + `${String(brief.taskBlockBytes)} (the field counts characters)`);
  }
  const imageDigest = manifest?.image?.digest;
  if (typeof imageDigest !== 'string') {
    problems.push('the manifest carries a brief but no image.digest, so the arm image it binds is unnamed');
  } else if (armMultiset === null) {
    if (problems.length === 0) {
      return { ok: true,
        skipped: `no arm manifest.json totals.multisetSha256 was readable under the arm dir, `
          + `so image.digest ${imageDigest} was not compared` };
    }
  } else if (imageDigest !== armMultiset) {
    problems.push(`arm multiset ${armMultiset} != manifest image.digest ${imageDigest}`);
  }
  if (problems.length === 0) return { ok: true };
  return { ok: false, detail: problems.join('; ') };
}

/**
 * The round-manifest requirement for a PAID route (fifteenth audit item 5).
 * A paid route could launch without `--manifest`, so the brief the money was
 * spent on was bound to nothing. The requirement is stated before anything is
 * wiped or spawned: no manifest, no launch.
 * @param {{paid: boolean, manifest: string|null}} input
 * @returns {{ok: boolean, detail?: string}}
 */
export function paidRouteManifestGate({ paid, manifest }) {
  if (paid !== true) return { ok: true };
  if (typeof manifest === 'string' && manifest !== '') return { ok: true };
  return { ok: false,
    detail: 'a paid route must name --manifest <round manifest>: the brief, the task sha256 and '
      + 'the arm image it binds are otherwise unverifiable, and the spend cannot be tied to a round' };
}

/**
 * The ARM TREE against the round manifest's `image.digest` (fifteenth audit item
 * 5). `manifestTaskGate` compares the arm's own `manifest.json` multiset; this
 * compares the bytes on disk, computed by the launcher's `digestTree` before the
 * launch, so a re-materialized tree that kept a stale `manifest.json` is caught.
 * @param {{manifest: object|null, digest: string|null,
 *   files?: number|null}} input - `digest` is `digestTree(armDir).digest`.
 * @returns {{ok: boolean, detail?: string}}
 */
export function armTreeGate({ manifest, digest, files = null }) {
  const imageDigest = manifest?.image?.digest;
  if (typeof imageDigest !== 'string' || imageDigest === '') {
    return { ok: false, detail: 'the round manifest carries no image.digest, so the arm tree has nothing to match' };
  }
  if (typeof digest !== 'string' || digest === '') {
    return { ok: false, detail: 'the arm tree digest was not read, so the round image cannot be checked' };
  }
  if (digest !== imageDigest) {
    return { ok: false,
      detail: `the arm tree hashes to ${digest}${typeof files === 'number' ? ` over ${String(files)} file(s)` : ''}, `
        + `not the round manifest's image.digest ${imageDigest}` };
  }
  return { ok: true };
}

/**
 * The enforcement record `result.json` carries for a round manifest (ISSUE-265).
 *
 * The launcher enforces the brief/task hash, the arm image and the deliverable
 * count; the per-record `tasks`, `totals`, `windowProjection`, `dist` and
 * `provenance` blocks are informational and are not compared to the run. Before
 * this record, a reader of `result.json` could not tell an enforced block from
 * an unread one. The list mirrors the gate: `brief.taskBlockBytes` appears only
 * when the brief carries the field, because that is the only case the gate
 * compares it (ISSUE-494). A resume round skips the brief and arm-tree gates by design, so
 * its record states that instead of claiming enforcement.
 *
 * @param {{manifest: object|null, resume?: boolean}} input
 * @returns {{present: boolean, enforced: string[], notEnforced: string[],
 *   readSets: string, skipped?: string}}
 */
export function manifestEnforcementRecord({ manifest, resume = false }) {
  const present = manifest !== null && typeof manifest === 'object';
  const enforced = [];
  if (present && !resume) {
    if (manifest.brief !== undefined && manifest.brief !== null) {
      enforced.push('brief.taskSha256');
      // `manifestTaskGate` compares the size only when the brief carries it, so
      // the record names it only then: a field that was never compared is not
      // enforced (ISSUE-494).
      if (manifest.brief.taskBlockBytes !== undefined) enforced.push('brief.taskBlockBytes');
    }
    if (manifest.deliverables !== undefined && manifest.deliverables !== null) {
      enforced.push('deliverables.count');
    }
    enforced.push('image.digest');
  }
  return {
    present,
    enforced,
    notEnforced: [
      'tasks (per-record roots, files and bytes)',
      'totals',
      'windowProjection',
      'dist',
      'provenance',
      'expectedFiresNote',
    ],
    readSets: 'not compared (the manifest marks the per-record read sets informational)',
    ...(resume ? { skipped: 'resume round: the brief hash and arm tree are not binding' } : {}),
  };
}
