#!/usr/bin/env node
/**
 * A dist tree's identity, so `result.json` states which build ran.
 *
 * Why this is its own module: `bench-run.mjs` ends with a top-level `await
 * main()`, so importing it runs the launcher. A pure helper the field needs has
 * to be importable by `node --test` without spawning a run.
 *
 * The identity is sha256 over the dist tree's sorted `path<TAB>sha256` lines.
 * Paths are relative to the dist root and POSIX-slashed, so the digest names
 * the tree's CONTENT and not the directory it was copied to: the frozen copy
 * and the default build agree byte-for-byte, and a moved tree stays the same
 * build. `text` is the exact bytes the digest covers (lines plus the final
 * newline), so the file R-1 pins as `build/dist.sha256.txt` can be checked with
 * plain `sha256sum` and must print `sha256`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * @param {string} dir - a dist root.
 * @returns {{sha256: string, files: number, text: string}}
 */
export function distTreeSha256(dir) {
  const lines = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = relative(dir, full).split(sep).join('/');
      lines.push(`${path}\t${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  };
  walk(dir);
  lines.sort();
  const text = `${lines.join('\n')}\n`;
  return { sha256: createHash('sha256').update(text).digest('hex'), files: lines.length, text };
}
