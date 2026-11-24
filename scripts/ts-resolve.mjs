// Maps test-lane imports onto TypeScript source:
//   - a relative ".js" specifier onto its sibling ".ts" file;
//   - a workspace package name (e.g. "@cremator/core") onto that package's source
//     entry, using the same `paths` table `tsconfig.json` uses for typecheck.
// Node's type stripping does not do the first; the second is what keeps the test
// lane off built `dist/`, so a red-proof of core source reaches the adapter tests
// without a rebuild (ISSUE-119).
// Do not set `format` here — leaving it undefined lets Node apply type stripping.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// `tsconfig.json` is the repo's own declaration of where a workspace name lives in
// source. Reading it keeps one owner for the mapping instead of a second table here.
// A read or parse failure is thrown, not swallowed into `{}`: an empty table sends
// every workspace name to package `exports`, which point at `./dist/`, and the lane
// then tests stale build output while reporting green (ISSUE-593).
const TSCONFIG = join(ROOT, 'tsconfig.json');

function readPaths() {
  let raw;
  try {
    raw = readFileSync(TSCONFIG, 'utf8');
  } catch (error) {
    throw new Error(`ts-resolve: cannot read ${TSCONFIG} (${error.message}); refused to fall back to dist/`);
  }
  try {
    return JSON.parse(raw).compilerOptions?.paths ?? {};
  } catch (error) {
    throw new Error(`ts-resolve: cannot parse ${TSCONFIG} (${error.message}); refused to fall back to dist/`);
  }
}

const PATHS = readPaths();

// A name mapping is used only when its target exists: a missing source file must not
// turn into a silent resolution failure of the built package that might be present.
function sourceTarget(specifier) {
  for (const [name, targets] of Object.entries(PATHS)) {
    if (name !== specifier) continue;
    for (const target of targets) {
      const candidate = join(ROOT, target);
      if (existsSync(candidate)) return pathToFileURL(candidate).href;
    }
  }
  return undefined;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true };
    }
  }
  const source = sourceTarget(specifier);
  if (source !== undefined) return { url: source, shortCircuit: true };
  return nextResolve(specifier, context);
}
