#!/usr/bin/env node
/**
 * `prep.mjs --sibling`: required, and pinned to the round's frozen bytes (ISSUE-090).
 *
 * The defect it closes: `--sibling` defaulted to the live
 * `C:/Users/TZhen/Desktop/miliastra-game-template` checkout, which has drifted
 * from the round's pin (4523 files, `508b1eec…`). A run on that default wrote
 * manifests pinning the wrong tree, silently: identity is measured between the
 * two arms, never against the pin.
 *
 * The gate now has two halves, both checked here on throwaway fixtures, never on
 * Desktop material: an absent `--sibling` is refused by name, and a sibling that
 * does not hash to the manifest's `sibling.totals` is refused with both digests.
 * `prep.mjs` ends in `main()`, so the checks spawn it rather than import it
 * (`max-tokens-flag.test.mjs` carries the same note).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(BENCH_DIR, 'prep.mjs');
const MANIFEST = join(BENCH_DIR, 'manifests', '2026-10-23-taskworld.manifest.json');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

/** A one-file source and a one-file sibling, both outside any real checkout. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'racoons-prep-pin-'));
  const src = join(base, 'src');
  const sibling = join(base, 'sibling');
  mkdirSync(src, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(src, 'AGENTS.md'), '# arm\n');
  writeFileSync(join(sibling, 'AGENTS.md'), '# template\n');
  return { base, src, sibling, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('prep sibling pin: an absent --sibling is refused by name, exit 2', () => {
  const result = run([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--sibling is required/u);
  // The refusal names the frozen copy and warns off the drifted checkout.
  assert.match(result.stderr, /_sibling-parked-2026-10-27/u);
  assert.match(result.stderr, /miliastra-game-template/u);
  // --help states the same rule, so the usage block cannot drift from the check.
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--sibling is required and has no default/u);
});

test('prep sibling pin: a sibling off the pin is refused, both digests printed', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const pin = JSON.parse(readFileSync(MANIFEST, 'utf8')).sibling.totals;
  const result = run(['--dry-run', '--src', f.src, '--root', join(f.base, 'root'), '--sibling', f.sibling]);
  assert.equal(result.status, 2, 'a one-file sibling cannot match the 4523-file pin');
  assert.match(result.stderr, /sibling does not match the round pin/u);
  // Expected comes from the manifest (outside the run); actual from this scan.
  assert.ok(result.stderr.includes(`expected ${pin.multisetSha256} over ${pin.files} file(s)`));
  assert.match(result.stderr, /actual {3}[0-9a-f]{64} over 1 file\(s\)/u);
  assert.ok(result.stderr.includes(f.sibling), 'the refused path is named');
});

test('prep sibling pin: the manifest pin is the extended round\'s frozen sibling', () => {
  // The expected value is pinned here too, so a manifest edit cannot quietly
  // re-pin the gate to the drifted live tree.
  const pin = JSON.parse(readFileSync(MANIFEST, 'utf8')).sibling.totals;
  assert.equal(pin.files, 4523);
  assert.equal(pin.multisetSha256, '508b1eecc12dbd3dc2b83079fbf3ce43bc72a937a738d8ad475d77a658846c8c');
});

test('prep sibling pin: --no-sibling still scans the arms alone', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const result = run(['--dry-run', '--no-sibling', '--src', f.src, '--root', join(f.base, 'root')]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /identity multiset [0-9a-f]{64} over 1 file\(s\)/u);
  assert.doesNotMatch(result.stdout, /sibling multiset/u);
});
