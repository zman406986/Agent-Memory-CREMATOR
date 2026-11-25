#!/usr/bin/env node
// Builds the browser artifact of the composer dock counter.
//
// The artifact is deliberately ONE classic script, not an ES module: the host
// client loader fetches it and evaluates it as a script that calls
// window.__ModuleLoader__.load({id, factory}). TypeScript is not involved, so
// this step copies the source verbatim and parses it as a classic script —
// an accidental `import`/`export` fails here instead of in the browser.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourceUrl = new URL('../client/client.js', import.meta.url);
const targetUrl = new URL('../dist/client.js', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8');

try {
  // Compiles without running. Classic-script syntax only.
  new Function(source);
} catch (error) {
  console.error('build-client: client/client.js is not a classic script: '
    + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

if (!process.exitCode) {
  mkdirSync(fileURLToPath(new URL('../dist', import.meta.url)), { recursive: true });
  writeFileSync(targetUrl, source);
  console.log('build-client: wrote ' + fileURLToPath(targetUrl));
}
