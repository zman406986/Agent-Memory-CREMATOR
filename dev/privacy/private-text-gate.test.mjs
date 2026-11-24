import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const GATE = fileURLToPath(new URL('./private-text-gate.mjs', import.meta.url));

function tempDir(t, prefix = 'racoons-gate-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runGate(root, extra = []) {
  return spawnSync(process.execPath, [GATE, '--root', root, ...extra], { encoding: 'utf8' });
}

test('clean tree exits 0 and prints PASS', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'notes.txt'), 'nothing private here\n', 'utf8');
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS: no private text/);
});

test('token list hit exits 1 and names file and line', (t) => {
  const dir = tempDir(t);
  const tokenDir = tempDir(t, 'racoons-gate-tokens-');
  writeFileSync(join(tokenDir, 'tokens.txt'), '# local list\nDUMMY-PRIVATE-NAME\n', 'utf8');
  writeFileSync(join(dir, 'secret.txt'), 'first line\ndummy-private-name here\n', 'utf8');
  const result = runGate(dir, ['--tokens', join(tokenDir, 'tokens.txt')]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /secret\.txt:2:/);
  assert.match(result.stdout, /1 hits in 1 files/);
});

test('bare TZhen exits 1; allowed home paths pass', (t) => {
  const bad = tempDir(t);
  writeFileSync(join(bad, 'x.txt'), 'owner TZhen here\n', 'utf8');
  const badResult = runGate(bad);
  assert.equal(badResult.status, 1, badResult.stdout + badResult.stderr);
  assert.match(badResult.stdout, /x\.txt:1:/);

  const good = tempDir(t);
  writeFileSync(
    join(good, 'x.txt'),
    'C:\\Users\\TZhen\\x\nC:\\Users\\TZ\\x\n',
    'utf8',
  );
  const goodResult = runGate(good);
  assert.equal(goodResult.status, 0, goodResult.stdout + goodResult.stderr);
  assert.match(goodResult.stdout, /PASS: no private text/);
});

test('Han text inside dev/bench/fixtures/sim exits 1', (t) => {
  const dir = tempDir(t);
  const fixtures = join(dir, 'dev', 'bench', 'fixtures', 'sim');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'x.jsonl'), '{"k":"深空"}\n', 'utf8');
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /dev\/bench\/fixtures\/sim\/x\.jsonl:1:/);
});

test('foreign home path exits 1; AAAAA placeholder passes', (t) => {
  const bad = tempDir(t);
  writeFileSync(join(bad, 'x.txt'), 'C:\\Users\\someone\\\n', 'utf8');
  const badResult = runGate(bad);
  assert.equal(badResult.status, 1, badResult.stdout + badResult.stderr);
  assert.match(badResult.stdout, /x\.txt:1:/);
  assert.match(badResult.stdout, /foreign home path/);

  const good = tempDir(t);
  writeFileSync(join(good, 'x.txt'), 'C:\\Users\\AAAAA\\\n', 'utf8');
  const goodResult = runGate(good);
  assert.equal(goodResult.status, 0, goodResult.stdout + goodResult.stderr);
  assert.match(goodResult.stdout, /PASS: no private text/);
});

test('UTF-16LE BOM text is decoded and scanned, not NUL-skipped (ISSUE-493)', (t) => {
  // PowerShell 5's Out-File default: UTF-16LE with a FF FE BOM. The NUL-byte
  // binary heuristic used to skip the whole file, so private text inside it
  // bypassed every rule and the token list.
  const dir = tempDir(t);
  const tokenDir = tempDir(t, 'racoons-gate-tokens-');
  writeFileSync(join(tokenDir, 'tokens.txt'), '# local list\nDUMMY-PRIVATE-NAME\n', 'utf8');
  const utf16le = (text) => Buffer.concat([
    Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le'),
  ]);
  writeFileSync(join(dir, 'token.txt'), utf16le('first line\r\ndummy-private-name here\r\n'));
  writeFileSync(join(dir, 'bare.txt'), utf16le('owner TZhen here\r\n'));
  writeFileSync(join(dir, 'home.txt'), utf16le('C:\\Users\\someone\\\r\n'));
  const result = runGate(dir, ['--tokens', join(tokenDir, 'tokens.txt')]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /token\.txt:2: private token match/);
  assert.match(result.stdout, /bare\.txt:1: bare private username TZhen/);
  assert.match(result.stdout, /home\.txt:1: foreign home path username "someone"/);
  assert.match(result.stdout, /3 hits in 3 files/);
});

test('UTF-16BE BOM text is decoded and scanned (ISSUE-493)', (t) => {
  const dir = tempDir(t);
  const body = Buffer.from('owner TZhen here\r\n', 'utf16le').swap16();
  writeFileSync(join(dir, 'be.txt'), Buffer.concat([Buffer.from([0xfe, 0xff]), body]));
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /be\.txt:1: bare private username TZhen/);
});

test('clean UTF-16 text passes; genuine binary is still skipped (ISSUE-493)', (t) => {
  const dir = tempDir(t);
  const clean = 'C:\\Users\\TZhen\\x\r\nC:\\Users\\AAAAA\\\r\nnothing private\r\n';
  writeFileSync(join(dir, 'clean.txt'), Buffer.concat([
    Buffer.from([0xff, 0xfe]), Buffer.from(clean, 'utf16le'),
  ]));
  // A genuine binary: NUL bytes, no UTF-16 BOM. Still skipped, no false positive.
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x7f]));
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS: no private text/);
});

test('unreadable tracked file fails closed: named refusal + nonzero (ISSUE-389)', (t) => {
  // A file tracked in the index but unreadable on disk (here: deleted after
  // `git add`) must not be silently skipped — a bare username inside it would
  // escape the scan. Cross-platform: no chmod tricks needed on Windows.
  const dir = tempDir(t);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'gone.txt'), 'owner TZhen here\n', 'utf8');
  execFileSync('git', ['add', '-f', 'gone.txt'], { cwd: dir });
  rmSync(join(dir, 'gone.txt'));
  const result = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /private-text-gate: .*gone\.txt/);
});
