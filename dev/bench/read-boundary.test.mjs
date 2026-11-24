#!/usr/bin/env node
/**
 * The bench arm's read boundary (ISSUE-039).
 *
 * The defect: Run B's racoons arm read the other arm's `derive-vanilla.json` and
 * the campaign's `build/VERDICT.md` in one `pwsh` call (step 34, seqs 303/306)
 * from an evidence root one directory above the arm. The launcher bounded writes
 * in prose and reads nowhere.
 *
 * The gates, from the issue's DoD:
 *
 *   (a) a path inside the campaign but outside the arm's world is a violation,
 *       and the offending call is named;
 *   (b) the Run B shape (a sibling arm's evidence dir, `derive-*.json`, `build/`)
 *       is refused as a world LAYOUT before any process starts;
 *   (c) a read inside the world, or outside the campaign altogether, is not a
 *       violation (the gate is the campaign line, not a machine-wide sandbox);
 *   (d) the Windows shapes the real run used parse: absolute drive paths inside
 *       a `pwsh` command string, `..` traversal, forward and back slashes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  campaignRootFor, classifyToolCalls, describeViolation, extractPaths, gitResolvesAbove, gitSubcommands,
  inside, worldLayoutViolations,
} from './read-boundary.mjs';
import { EXIT_CODES, exitCodeFor } from './launch-outcome.mjs';

/** A fixture campaign: a world with an arm and an evidence dir, plus the leaked shape.
 *
 * The fixture lives under the OS temp dir, which the classifier treats as a
 * read-write scratch root by default — so every test here passes `scratch: []`
 * and the one test that exercises the temp allowance says so. A real campaign
 * never sits in a scratch root; making the fixture's location look like one
 * would hide the very containment this module exists to check.
 */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'racoons-read-boundary-'));
  const campaign = join(base, 'campaign');
  const world = join(campaign, 'worlds', 'racoons');
  const arm = join(world, 'arm');
  const evidence = join(world, 'evidence');
  mkdirSync(arm, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(arm, 'AGENTS.md'), '# rules\n');
  return {
    base,
    campaign,
    world,
    arm,
    evidence,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** Classify with the scratch allowance off, so the fixture's own location is judged. */
function classify(f, sessionEvents, extra = {}) {
  return classifyToolCalls({
    sessionEvents,
    workDir: f.arm,
    worldRoots: [f.world],
    campaignRoot: campaignRootFor({ worldRoot: f.world, root: f.campaign, armDir: f.arm, evidenceDir: f.evidence }),
    evidenceDir: f.evidence,
    scratch: [],
    ...extra,
  });
}

function call(name, input, seq = 1) {
  return { type: 'tool/call', seq, data: { name, callId: `call_${String(seq)}`, arguments: JSON.stringify(input) } };
}

test('039 (a) a read of the other arm\'s derivation is a violation, with the call named', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  writeFileSync(join(f.campaign, 'derive-vanilla.json'), '{}\n');
  const report = classify(f, [
    call('read', { file_path: join(f.arm, 'AGENTS.md') }, 1),
    call('read', { file_path: join(f.campaign, 'derive-vanilla.json') }, 2),
  ]);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].tool, 'read');
  assert.equal(report.violations[0].seq, 2);
  assert.match(report.violations[0].path, /derive-vanilla\.json$/u);
  assert.equal(report.inside, 1);
  assert.match(describeViolation(report.violations[0]), /read call seq 2 named/u);
});

test('039 (a) the Run B shape: the campaign verdict in a pwsh command string', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  mkdirSync(join(f.campaign, 'build'), { recursive: true });
  writeFileSync(join(f.campaign, 'build', 'VERDICT.md'), '# verdict\n');
  // Run B's step 34, verbatim in shape: the root goes into a variable on the
  // first line, the artifacts are joined onto it on the next.
  const command = `$l='${f.campaign.split('\\').join('\\')}'\n`
    + "Get-Content -Raw -Encoding UTF8 (Join-Path $l 'build\\VERDICT.md')\n"
    + "Write-Output '--- derive json'\n"
    + `Get-Content -Raw -Encoding UTF8 (Join-Path $l 'derive-vanilla.json')`;
  const report = classify(f, [call('pwsh', { command }, 34)]);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].tool, 'pwsh');
  assert.equal(report.violations[0].resolved, f.campaign);
});

test('039 (a) the other arm\'s evidence dir is a violation', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const other = join(f.campaign, 'worlds', 'vanilla', 'evidence');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'result.json'), '{}\n');
  const report = classify(f, [call('read', { file_path: join(other, 'result.json') }, 7)]);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].seq, 7);
});

test('039 (b) a world carrying derivation or a sibling arm\'s evidence is refused', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  mkdirSync(join(f.world, 'build'), { recursive: true });
  writeFileSync(join(f.world, 'derive-vanilla.json'), '{}\n');
  writeFileSync(join(f.world, 'VERDICT.md'), '# verdict\n');
  const sibling = join(f.world, 'vanilla-mock');
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, 'result.json'), '{}\n');
  const problems = worldLayoutViolations({
    worldRoot: f.world, armDir: f.arm, evidenceDir: f.evidence,
  });
  const text = problems.join('\n');
  assert.match(text, /build is a campaign build tree/u);
  assert.match(text, /derive-vanilla\.json is a derivation artifact/u);
  assert.match(text, /VERDICT\.md is a campaign verdict/u);
  assert.match(text, /vanilla-mock is another arm's evidence dir/u);
});

test('039 (b) an isolated world has no problems; an arm at the world root is refused', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.deepEqual(worldLayoutViolations({ worldRoot: f.world, armDir: f.arm, evidenceDir: f.evidence }), []);
  const problems = worldLayoutViolations({
    worldRoot: f.arm, armDir: f.arm, evidenceDir: join(f.arm, 'evidence'),
  });
  assert.ok(problems.some((line) => /the arm IS the world root/u.test(line)), problems.join('\n'));
});

test('039 (c) a read outside the campaign is recorded, never a violation', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const outside = process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/hostname';
  const report = classify(f, [call('read', { file_path: outside }, 3)]);
  assert.equal(report.violations.length, 0);
  assert.equal(report.outside.length, 1);
});

test('039 (c) an allow-listed root is neither inside nor a violation', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const scratch = mkdtempSync(join(tmpdir(), 'racoons-allowed-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const report = classify(f, [call('read', { file_path: join(scratch, 'note.txt') }, 4)], { allow: [scratch] });
  assert.equal(report.allowed, 1);
  assert.equal(report.violations.length, 0);
  assert.equal(report.outside.length, 0);
});

test('039 (c) an allow-listed root is READ-only: a write there is a violation', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const template = mkdtempSync(join(tmpdir(), 'racoons-template-'));
  t.after(() => rmSync(template, { recursive: true, force: true }));
  const report = classify(f, [
    call('edit', { file_path: join(template, 'docs', 'index.md') }, 5),
    call('read', { file_path: join(template, 'AGENTS.md') }, 6),
  ], { allow: [template] });
  assert.equal(report.allowed, 1, 'the read is allowed');
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].scope, 'read-only');
  assert.match(describeViolation(report.violations[0]), /a write under read-only/u);
});

test('039 (d) Windows path shapes parse: drive paths, forward slashes, `..` traversal', () => {
  const command = 'Get-Content -Raw -Encoding UTF8 C:\\Users\\TZhen\\Desktop\\racoons\\scratchpad\\launch\\x\\derive-vanilla.json; '
    + "Set-Location ..\\..; Get-ChildItem -Force";
  const paths = extractPaths({ command });
  assert.ok(paths.includes('C:\\Users\\TZhen\\Desktop\\racoons\\scratchpad\\launch\\x\\derive-vanilla.json'), paths.join(' | '));
  assert.ok(paths.includes('..\\..'), paths.join(' | '));
  const forward = extractPaths({ file_path: 'C:/Users/TZhen/Desktop/racoons/build/VERDICT.md' });
  assert.deepEqual(forward, ['C:/Users/TZhen/Desktop/racoons/build/VERDICT.md']);
});

test('039 (d) `..` is resolved against the child cwd, and can land in the campaign', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  writeFileSync(join(f.world, 'VERDICT.md'), '# verdict\n');
  const report = classify(f, [call('read', { file_path: '..\\VERDICT.md' }, 9)]);
  assert.equal(report.inside, 1, 'a `..` read that stays in the world is inside');
  // Two levels up from the arm is the world root; three is the campaign. The
  // gate must see the campaign-landing one.
  writeFileSync(join(f.campaign, 'derive-vanilla.json'), '{}\n');
  const up = classify(f, [call('read', { file_path: '../../../derive-vanilla.json' }, 10)]);
  assert.equal(up.violations.length, 1);
  assert.equal(up.violations[0].resolved, resolve(f.campaign, 'derive-vanilla.json'));
});

test('039 (d) an unparseable argument string is still scanned', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  writeFileSync(join(f.campaign, 'derive-vanilla.json'), '{}\n');
  const report = classify(f, [{
    type: 'tool/call',
    seq: 11,
    data: { name: 'pwsh', callId: 'call_11', arguments: `{"command": "cat ${join(f.campaign, 'derive-vanilla.json')}"` },
  }]);
  assert.equal(report.violations.length, 1);
});

test('039 (d) containment is case-insensitive and separator-agnostic on Windows', () => {
  const outer = 'C:\\Users\\TZhen\\Desktop\\racoons\\scratchpad\\bench';
  assert.equal(inside(outer, 'c:/users/tzhen/desktop/racoons/scratchpad/bench/arm/AGENTS.md'), true);
  assert.equal(inside(outer, 'C:\\Users\\TZhen\\Desktop\\racoons\\scratchpad\\benchmark'), false);
});

// ── ISSUE-047: name only the paths a call can actually reach ───────────────
// The 2026-10-25 run-040 log carried four commands whose path token was glued
// to the shell word after it (`<dir> -Force`, `<repo> log --all`, `<dir>
// -Recurse -Filter`), and one `edit` whose payload names the template. Those
// are the fixtures below; the true-positive cases prove precision did not turn
// into blindness.

test('047 (a) the seq-137 shape: `Get-ChildItem <world> -Force` names the directory, not ` -Force`', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const template = join(f.base, 'miliastra-game-template');
  const command = `Get-ChildItem ${f.world} -Force | Select-Object Name | Format-Table -AutoSize; `
    + "Write-Host '--- template specs'; "
    + `Test-Path ${join(template, 'docs', 'specs', 'index.md')}; `
    + "Write-Host '--- arm specs/build/scratchpad'; "
    + `'docs/specs','build','scratchpad' | ForEach-Object { "$_ $(Test-Path $_)" }`;
  const paths = extractPaths({ command });
  assert.ok(paths.includes(f.world), paths.join(' | '));
  assert.ok(!paths.some((path) => /\s-F/u.test(path)), `a switch was glued on: ${paths.join(' | ')}`);
  const report = classify(f, [call('pwsh', { command }, 137)], { allow: [template] });
  assert.deepEqual(report.violations, []);
  assert.equal(report.inside, 1, JSON.stringify(report));
  assert.equal(report.allowed, 1, JSON.stringify(report));
});

test('047 (a) a shell word after a path does not extend it (seqs 445, 838)', () => {
  const repo = String.raw`C:\Users\TZhen\Desktop\Taskworld-Project`;
  const template = String.raw`C:\Users\TZhen\Desktop\miliastra-game-template`;
  assert.deepEqual(extractPaths({ command: `git -C ${repo} log --all --oneline -- docs/specs` }), [repo]);
  assert.deepEqual(extractPaths({ command: `Get-ChildItem ${template} -Recurse -Filter '*platform-facts*'` }), [template]);
});

test('047 (a) the seq-20 shape: an outside listing records the real directory, not ` -Force`', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const elsewhere = join(f.base, 'Desktop');
  mkdirSync(elsewhere, { recursive: true });
  const report = classify(f, [call('pwsh', {
    command: `Get-ChildItem ${elsewhere} -Force | Select-Object Mode,Name | Format-Table -AutoSize`,
  }, 20)]);
  assert.deepEqual(report.violations, []);
  assert.equal(report.outside.length, 1);
  assert.equal(report.outside[0].path, elsewhere);
});

test('047 (a) a quoted path keeps its spaces; an unquoted one ends at the space', () => {
  const spaced = String.raw`C:\Program Files\Some App\a.txt`;
  assert.deepEqual(extractPaths({ command: `Get-Content "${spaced}" -Raw` }), [spaced]);
  assert.deepEqual(extractPaths({ file_path: spaced }), [spaced]);
  assert.deepEqual(extractPaths({ command: `Get-Content ${spaced}` }), [String.raw`C:\Program`]);
});

test('047 (b) an edit\'s `new_string` is document text, not a path (seq 316)', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const template = join(f.base, 'miliastra-game-template');
  const target = join(f.arm, 'docs', 'project', 'index.md');
  const input = {
    file_path: target,
    old_string: 'the template',
    new_string: 'the template at `../miliastra-game-template/docs/project/index.md`',
  };
  assert.deepEqual(extractPaths(input), [target]);
  const world = classify(f, [call('edit', input, 316)], { allow: [template] });
  assert.deepEqual(world.violations, []);
  assert.equal(world.inside, 1);
  // The legacy layout (no `--world`) roots the world at the arm and its
  // evidence dir, so the payload would land in the campaign there. Skipping it
  // must hold in both configurations.
  const legacy = classify(f, [call('edit', input, 316)], {
    allow: [template], worldRoots: [f.arm, f.evidence], campaignRoot: f.campaign,
  });
  assert.deepEqual(legacy.violations, []);
});

test('047 (b) a write\'s `content` names the template without writing to it', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const template = join(f.base, 'miliastra-game-template');
  const note = join(f.arm, 'NOTES.md');
  const input = { file_path: note, content: `the template lives at ${join(template, 'docs', 'index.md')}` };
  assert.deepEqual(extractPaths(input), [note]);
  // `write` is mutating, so a template path in the payload used to read as a
  // write under the read-only allow root.
  const report = classify(f, [call('write', input, 317)], { allow: [template] });
  assert.deepEqual(report.violations, []);
  assert.equal(report.inside, 1);
});

test('047 (c) a genuine out-of-world read in a command string still violates, and names the call', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  mkdirSync(join(f.campaign, 'build'), { recursive: true });
  const verdict = join(f.campaign, 'build', 'VERDICT.md');
  writeFileSync(verdict, '# verdict\n');
  const command = `Get-Content ${verdict} -Raw; Write-Host '---'; Get-ChildItem ${f.campaign} -Filter 'derive-*'`;
  const report = classify(f, [call('pwsh', { command }, 303)]);
  assert.equal(report.violations.length, 2, JSON.stringify(report.violations));
  assert.equal(report.violations[0].seq, 303);
  assert.equal(report.violations[0].resolved, verdict);
  assert.equal(report.violations[1].resolved, f.campaign);
  assert.match(describeViolation(report.violations[0]), /pwsh call seq 303 named/u);
  assert.equal(report.inside, 0);
});

test('047 (c) a `..\\..` listing is a real out-of-world read (run-040 seq 174), not a glued token', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  // The old extractor produced `..\.. -Force`, which resolved under the ARM and
  // so escaped the gate. The directory the command actually lists is the
  // world's parent: campaign material, and the gate must say so.
  const command = 'Get-ChildItem .. -Force; Write-Host \'--- launch\'; Get-ChildItem ..\\.. -Force';
  // A lone `..` is not extracted (it cannot leave the world from the arm) and
  // that is unchanged; the two-level token is, and it is one token.
  assert.deepEqual(extractPaths({ command }), ['..\\..']);
  const report = classify(f, [call('pwsh', { command }, 174)]);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].path, '..\\..');
  assert.equal(report.violations[0].resolved, resolve(f.world, '..'));
  assert.equal(report.violations[0].scope, 'campaign');
});

test('047 (d) a genuine write under an allow-listed root still violates as read-only', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const template = join(f.base, 'miliastra-game-template');
  const report = classify(f, [call('edit', {
    file_path: join(template, 'docs', 'index.md'),
    old_string: 'a',
    new_string: 'b',
  }, 400)], { allow: [template] });
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].scope, 'read-only');
  assert.equal(report.violations[0].resolved, join(template, 'docs', 'index.md'));
  assert.equal(exitCodeFor({
    watchdogFired: false, failures: 0, violations: report.violations.length,
    denySkipped: false, verdict: 'pass', realApi: true,
  }), EXIT_CODES.readOutOfScope);
});

test('047 (e) the launcher\'s accounting: a 047-shaped arm is green, a real read is exit 4', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const code = (report) => exitCodeFor({
    watchdogFired: false, failures: 0, violations: report.violations.length,
    denySkipped: false, verdict: 'partial', realApi: true,
  });
  const clean = classify(f, [call('pwsh', { command: `Get-ChildItem ${f.world} -Force` }, 137)]);
  assert.deepEqual(clean.violations, []);
  assert.equal(code(clean), EXIT_CODES.green);
  const dirty = classify(f, [call('pwsh', { command: `Get-Content ${join(f.campaign, 'derive-vanilla.json')} -Raw` }, 303)]);
  assert.equal(dirty.violations.length, 1);
  assert.equal(code(dirty), EXIT_CODES.readOutOfScope);
});

test('047 (e) the `working_directory` target is judged like any other path target', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const report = classify(f, [call('working_directory', { cd: f.campaign }, 500)]);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].scope, 'campaign');
  assert.deepEqual(classify(f, [call('working_directory', { cd: f.arm }, 501)]).violations, []);
});

// ── A parent token with no file component is not a read ────────────────────
// The 2026-11-08 two-option run failed on seven `pwsh` calls whose Python
// string literals contain `'../'` (`s.startswith('../')`). The token `../`
// normalizes to the parent directory itself — the shape a bare `..` was always
// excluded for — and it is code text, not a location. A token naming something
// UNDER the parent stays a path the gate judges.

test('a `\'../\'` literal, `cd ..` and `cd ../` name no path; a lone `..` names none either', () => {
  assert.deepEqual(extractPaths({ command: "s.startswith('../')" }), []);
  assert.deepEqual(extractPaths({ command: 'cd ..' }), []);
  assert.deepEqual(extractPaths({ command: 'cd ../' }), []);
  assert.deepEqual(extractPaths({ command: 'cd ..\\' }), []);
  assert.deepEqual(extractPaths({ file_path: '..' }), []);
});

test('a parent token with a file component is still emitted', () => {
  assert.deepEqual(extractPaths({ command: 'Get-Content ../secret' }), ['../secret']);
  assert.deepEqual(extractPaths({ command: "open('../secret')" }), ['../secret']);
  assert.deepEqual(extractPaths({ command: 'cat ../x' }), ['../x']);
  assert.deepEqual(extractPaths({ command: 'cat ..\\x' }), ['..\\x']);
});

test('a here-string literal `\'../\'` neither invents nor hides a real `../secret`', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const command = [
    '$code = @\'',
    "if s.startswith('../'): pass",
    "'@",
    "open('../secret')",
  ].join('\n');
  assert.deepEqual(extractPaths({ command }), ['../secret']);
  // The world is the arm plus its evidence dir (the legacy layout the failing
  // run used), so `..` from the arm is the campaign: the literal would have
  // been a violation, the real open still is.
  const report = classify(f, [call('pwsh', { command }, 314)], {
    worldRoots: [f.arm, f.evidence], campaignRoot: f.campaign,
  });
  assert.equal(report.violations.length, 1, JSON.stringify(report.violations));
  assert.equal(report.violations[0].path, '../secret');
});

// ── The git channel ────────────────────────────────────────────────────────
// The 2026-10-28 extended campaign's vanilla arm ran
// `git rev-parse --is-inside-work-tree; git log --oneline -3` (seq 1926) from a
// world with no `.git`. The campaign root has none either, so git climbed into
// this repository and returned commit subjects: a read of content above every
// declared root that named no path and so was invisible to `extractPaths`. The
// rows are recorded, never gated — the content sits outside the campaign, which
// is the recorded-evidence line — but they must be counted and named.

test('git channel (a) a git read from a world with no `.git` anywhere below the campaign is recorded', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  // The shape the vanilla arm used, verbatim.
  const command = 'git rev-parse --is-inside-work-tree 2>&1; git log --oneline -3 2>&1';
  assert.deepEqual(extractPaths({ command }), [], 'the defect: a git call names no path');
  const report = classify(f, [call('pwsh', { command }, 1926)]);
  assert.equal(report.gitChannel.length, 1, JSON.stringify(report.gitChannel));
  assert.equal(report.gitChannel[0].seq, 1926);
  assert.deepEqual(report.gitChannel[0].verbs, ['rev-parse', 'log']);
  assert.equal(report.violations.length, 0, 'recorded, never gated');
  assert.equal(gitResolvesAbove({ from: f.arm, campaignRoot: f.campaign }), true);
});

test('git channel (b) a campaign root carrying `.git` stops resolution, so nothing is recorded', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  mkdirSync(join(f.campaign, '.git'), { recursive: true });
  const report = classify(f, [call('pwsh', { command: 'git log --oneline -3' }, 1926)]);
  assert.equal(gitResolvesAbove({ from: f.arm, campaignRoot: f.campaign }), false);
  assert.deepEqual(report.gitChannel, []);
  assert.equal(report.violations.length, 0);
  // A `.git` in the world itself is a boundary too.
  assert.equal(gitResolvesAbove({
    from: f.arm, campaignRoot: f.campaign, exists: (path) => path === join(f.arm, '.git'),
  }), false);
});

test('git channel (c) an ordinary out-of-world listing still gates; a pinned or non-read git call is not a row', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  mkdirSync(join(f.campaign, 'build'), { recursive: true });
  writeFileSync(join(f.campaign, 'build', 'VERDICT.md'), '# verdict\n');
  // No regression: the path gate is unchanged by the new class.
  const listing = classify(f, [call('pwsh', { command: `Get-ChildItem ${join(f.campaign, 'build')} -Force` }, 7)]);
  assert.equal(listing.violations.length, 1);
  assert.deepEqual(listing.gitChannel, []);
  // `--git-dir` names the repository, so the call cannot climb; `git add` is not
  // a read. `-C` only changes the directory and still climbs.
  const pinned = classify(f, [call('pwsh', { command: `git --git-dir ${join(f.arm, '.git')} log --oneline` }, 8)]);
  assert.deepEqual(pinned.gitChannel, []);
  const changed = classify(f, [call('pwsh', { command: `git -C ${f.arm} log --oneline` }, 10)]);
  assert.equal(changed.gitChannel.length, 1, 'a `-C` call still resolves upward');
  const write = classify(f, [call('pwsh', { command: 'git add .', description: 'stage' }, 9)]);
  assert.deepEqual(write.gitChannel, []);
  assert.deepEqual(gitSubcommands('git -C C:\\x log --oneline').map((row) => row.verb), ['log']);
  assert.deepEqual(gitSubcommands('git status; git show HEAD'), [{ verb: 'status', pinned: false },
    { verb: 'show', pinned: false }]);
});

// ── ISSUE-235 item 5: the evidence dir is not a readable world root ───────
// `--world` puts the evidence dir at <world>/evidence and makes the world the
// only root, so the classifier used to count a tool call naming the session
// log, journal, ledger or blobs as `inside`. The mount writes those files, but
// the mount's writes are not tool calls; a tool call that names them is the
// agent reaching for the harness's own record. `judged` exists because
// `inside: 0` alone cannot tell a clean boundary from an unchecked one.

test('235 (item 5) a tool call naming the evidence dir is an evidence-path violation, never `inside`', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const log = join(f.evidence, 'session.v4.jsonl');
  writeFileSync(log, '{}\n');
  const report = classify(f, [
    call('read', { file_path: log }, 900),
    // The shape the defect describes: `..` from the arm lands in <world>/evidence.
    call('read', { file_path: join('..', 'evidence', 'session.v4.jsonl') }, 901),
    call('pwsh', { command: `Get-Content ${log} -Raw` }, 902),
  ]);
  assert.equal(report.violations.length, 3, JSON.stringify(report.violations));
  assert.deepEqual(report.violations.map((row) => row.scope),
    ['evidence-path', 'evidence-path', 'evidence-path']);
  assert.equal(report.inside, 0, 'the evidence dir must not be counted as inside');
  assert.equal(report.judged, 3);
  assert.match(describeViolation(report.violations[0]), /the evidence dir: harness output, not a tool target/u);
  // The dry-work copy sits at <evidence>/work and is the child's cwd: a world
  // root nested inside the evidence dir, not harness output.
  const workCopy = join(f.evidence, 'work');
  mkdirSync(workCopy, { recursive: true });
  const copyFile = join(workCopy, 'AGENTS.md');
  writeFileSync(copyFile, '# rules\n');
  const withCopy = classify(f, [call('read', { file_path: copyFile }, 903)], {
    worldRoots: [f.world, workCopy],
  });
  assert.deepEqual(withCopy.violations, []);
  assert.equal(withCopy.inside, 1);
  assert.equal(withCopy.judged, 1);
  // The mount's own writes are not tool calls: no session event, no row.
  const mountOnly = classify(f, []);
  assert.equal(mountOnly.judged, 0);
  assert.deepEqual(mountOnly.violations, []);
});

test('235 (item 5) `judged` counts every extracted path, and an empty judge set is reported as zero', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  writeFileSync(join(f.arm, 'AGENTS.md'), '# rules\n');
  writeFileSync(join(f.campaign, 'derive-vanilla.json'), '{}\n');
  const outside = process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/hostname';
  const report = classify(f, [
    call('read', { file_path: join(f.arm, 'AGENTS.md') }, 1),
    call('read', { file_path: join(f.campaign, 'derive-vanilla.json') }, 2),
    call('read', { file_path: join(f.evidence, 'journal.jsonl') }, 3),
    call('read', { file_path: outside }, 4),
  ]);
  assert.equal(report.judged, 4);
  assert.equal(report.inside, 1);
  assert.equal(report.allowed, 0);
  assert.equal(report.violations.length, 2);
  assert.equal(report.outside.length, 1);
  // A relative path is outside the scan's declared scope. With nothing but such
  // calls the judge set is empty, and `judged: 0` says so instead of leaving
  // `inside: 0` to be read as a clean boundary.
  const empty = classify(f, [call('read', { file_path: 'AGENTS.md' }, 5)]);
  assert.equal(empty.judged, 0);
  assert.equal(empty.inside, 0);
  assert.deepEqual(empty.violations, []);
});

// ── A pattern operand is not a path (2026-11-09 pair-b) ────────────────────
// Four vanilla-arm `pwsh` calls read `docs/project`, `docs/guides` and
// `docs/adr` and were failed on `../*`, the operand of `$p -like '../*'`. The
// same calls define `$rx = [regex]'(?:\.\./)?...'`, whose dots are escaped.
// Neither token names a location. A literal read in the same command shape
// must keep failing (ISSUE-241).

test('2026-11-09 pair-b: a `-like` wildcard operand and a `[regex]` literal name no path', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const command = [
    "$ErrorActionPreference='Stop'",
    '$files = Get-ChildItem docs/project,docs/guides,docs/adr -Recurse -Filter *.md',
    "$rx = [regex]'(?<![A-Za-z0-9_-./])(?:../|\\./)?(?:[A-Za-z0-9_-]+/)+[A-Za-z0-9_-]+\\.md'",
    '$seen=@{}',
    'foreach($f in $files){ foreach($m in $rx.Matches($f)){ $p=$m.Value; '
      + "if($p -like '../*' -or $p -like './*'){ $status='OUTSIDE' } } }",
  ].join('\n');
  assert.deepEqual(extractPaths({ command }), []);
  const report = classify(f, [call('pwsh', { command }, 261)]);
  assert.equal(report.judged, 0, 'a pattern operand is not a judged path');
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.outside, []);
});

test('2026-11-09 pair-b: the fixed pattern contexts are masked; a wildcard argument to a reader is not', () => {
  assert.deepEqual(extractPaths({ command: "$p -match '../secret'" }), []);
  assert.deepEqual(extractPaths({ command: "$p -replace 'a','../b'" }), []);
  assert.deepEqual(extractPaths({ command: "Select-String -Pattern '../secret' -Path ../real.txt" }),
    ['../real.txt'], 'only the -Pattern operand is masked');
  assert.deepEqual(extractPaths({ command: "$rx = '../secret'; Get-Content $rx" }), []);
  assert.deepEqual(extractPaths({ command: "$pattern = '../secret'" }), []);
  // A pattern outside a recognized context is still not a path, but the same
  // token as an argument of a file-reading command is one.
  assert.deepEqual(extractPaths({ command: "Write-Output '../*'" }), []);
  assert.deepEqual(extractPaths({ command: 'Get-ChildItem ../* -Force' }), ['../*']);
});

test('2026-11-09 pair-b: a literal `Get-Content ../secrets.txt` still fails', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const command = 'Get-Content ../secrets.txt -Raw';
  assert.deepEqual(extractPaths({ command }), ['../secrets.txt']);
  // The pair-b layout roots the world at the arm alone, so `..` is out of the
  // world even though the fixture's default world would contain it.
  const report = classify(f, [call('pwsh', { command }, 300)], { worldRoots: [f.arm] });
  assert.equal(report.judged, 1);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].path, '../secrets.txt');
  assert.equal(report.violations[0].scope, 'campaign');
  // A real `ls` listing of the parent's parent still parses and still fails.
  assert.deepEqual(extractPaths({ command: 'ls ..\\..' }), ['..\\..']);
  const listing = classify(f, [call('pwsh', { command: 'ls ..\\..' }, 301)], { worldRoots: [f.arm] });
  assert.equal(listing.violations.length, 1);
  assert.equal(listing.violations[0].path, '..\\..');
  assert.equal(listing.violations[0].scope, 'campaign');
});
