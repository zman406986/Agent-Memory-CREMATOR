/**
 * The one path identity and containment decision for `dev/` (ISSUE-582).
 *
 * Dev sites compared spellings: `!==`, `===`, `startsWith`, or a `join` with no
 * containment test. A Windows case variant, a junction or a `..` walked past
 * each of them. Identity is decided on the resolved path, with case folded only
 * where the filesystem folds it (win32); containment is decided by
 * `path.relative`, whose `..` answer is the one escape shape a caller must
 * refuse. `path.win32.relative` already compares case-insensitively, so the
 * relative form keeps the spelling the caller passed while still seeing the
 * case variant as the same path.
 *
 * `canonicalPath` is for a site that visibly checks a real tree (an evidence
 * dir, an arm, a read root): it follows a junction or symlink so a narrow root
 * cannot be a link into a forbidden tree, and falls back to the nearest
 * existing ancestor when the tail does not exist yet.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Windows compares names case-insensitively; POSIX compares them byte for byte. */
const CASE_INSENSITIVE = process.platform === 'win32';

/** The comparison key: resolved, and folded only on win32. */
function key(value) {
  const absolute = resolve(value);
  return CASE_INSENSITIVE ? absolute.toLowerCase() : absolute;
}

/** `true` when `left` and `right` name the same path after `resolve`. */
export function samePath(left, right) {
  return key(left) === key(right);
}

/**
 * `inner`'s path relative to `outer`, or `null` when it is neither `outer` nor
 * under it. `''` means the same path. A `..` answer (or an absolute one, which
 * a different drive produces) is an escape and is never returned.
 * @returns {string|null}
 */
export function relativeInside(outer, inner) {
  const rel = relative(resolve(outer), resolve(inner));
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
}

/** `true` when `inner` is `outer` or sits under it. */
export function inside(outer, inner) {
  return relativeInside(outer, inner) !== null;
}

/**
 * The canonical (realpath) form of a path, or the resolved path with the
 * nearest existing ancestor realpathed. A junction or symlink is followed, so a
 * narrow evidence or allow-read root cannot be a link into a forbidden tree.
 * @param {string} path
 * @returns {string}
 */
export function canonicalPath(path) {
  let current = resolve(path);
  const suffix = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return suffix.length === 0 ? real : join(real, ...suffix.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      suffix.push(basename(current));
      current = parent;
    }
  }
}
