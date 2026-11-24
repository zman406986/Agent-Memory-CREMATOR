#!/usr/bin/env node
// Build pwsh-guard.exe with the .NET Framework compiler that ships with
// Windows (no SDK install, no package). Writes the exe and its ini side by side.
//
// usage: node dev/bench/pwsh-guard/build.mjs [--out <dir>] [--real-pwsh <exe>]
//          [--allow-root <dir> ...]
//
// The ini lists the real pwsh and every extra readable root (the bench passes
// the venv tree). The workspace root is the child's cwd at run time and is
// always allowed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { optionsOf, parseDevArgs } from '../../shared/args.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** The flag table (ISSUE-392): the shared parser binds values, never the next flag. */
const BUILD_OPTIONS = optionsOf([
  ['--out', 'string'],
  ['--real-pwsh', 'string'],
  ['--allow-root', 'string', 'allowRoot', { multiple: true }],
]);

export function parseArgs(argv) {
  // Throws with a plain message; `main` prints it with the script's prefix and
  // exits 2.
  const { values } = parseDevArgs(argv, { options: BUILD_OPTIONS });
  return {
    out: values.out ?? null,
    realPwsh: values.realPwsh ?? null,
    allowRoots: values.allowRoot ?? [],
  };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`build.mjs: ${error.message}`);
    process.exit(2);
  }
  const outDir = resolve(opts.out ?? join(here, '..', '..', '..', 'build', 'pwsh-guard'));
  const cscCandidates = [
    'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
    'C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe',
  ];
  const csc = cscCandidates.find((p) => existsSync(p));
  if (csc === undefined) {
    console.error('build.mjs: no .NET Framework csc.exe found');
    process.exit(2);
  }

  const realPwsh = opts.realPwsh
    ?? ['C:/Program Files/PowerShell/7/pwsh.exe', 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe']
      .find((p) => existsSync(p));
  if (realPwsh === undefined) {
    console.error('build.mjs: no real pwsh found; pass --real-pwsh');
    process.exit(2);
  }

  const allowRoots = opts.allowRoots.map((root) => resolve(root));

  mkdirSync(outDir, { recursive: true });
  const exe = join(outDir, 'pwsh-guard.exe');
  const src = join(here, 'pwsh-guard.cs');
  const build = spawnSync(csc, ['-nologo', '-optimize+', '-target:exe', `-out:${exe}`, src], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  if (build.status !== 0) {
    console.error(`${build.stdout ?? ''}${build.stderr ?? ''}`);
    process.exit(build.status ?? 1);
  }

  const ini = [
    `realPwsh=${realPwsh}`,
    ...allowRoots.map((root) => `allowRoot=${root}`),
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'pwsh-guard.ini'), ini);

  const digest = createHash('sha256').update(readFileSync(exe)).digest('hex');
  console.log(`built ${exe}`);
  console.log(`sha256 ${digest}`);
  console.log(`ini ${join(outDir, 'pwsh-guard.ini')}`);
  console.log(ini.trimEnd());
}

// A direct run builds; an import (the parser regression test) does not.
if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}