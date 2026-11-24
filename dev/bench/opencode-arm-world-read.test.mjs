/**
 * The read boundary's third tolerated root: the arm world itself.
 *
 * The 1f model read `<arm>/world` for orientation (the listing was
 * `.cache .config .local appdata home tmp work`) immediately after listing its
 * work copy, and the old boundary called it a `deny-root` violation although the
 * path is the run's own sandbox, not fixture or run evidence. The root is
 * tolerated by name (`arm-world`), narrow: a junction/symlink out of it is still
 * an escape, the evidence root outside the world is still denied, and the
 * host-cache and host-temp shapes keep their more specific kind.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyWorkspaceReads } from './opencode-run.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'cremator-opencode-arm-world-'));

const readCall = (id, path) => ({
  role: 'assistant',
  tool_calls: [{ id, type: 'function',
    function: { name: 'read', arguments: JSON.stringify({ path }) } }],
});

/** `<dir>/world` with the work copy inside it: the arm world the 1f run read. */
function armWorld(dir) {
  const world = join(dir, 'world');
  const workspace = join(world, 'work');
  mkdirSync(workspace, { recursive: true });
  return { world, workspace };
}

test('a read of the arm world root is arm-world, not a violation', (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { world, workspace } = armWorld(dir);
  const requests = [{
    seq: 1,
    kind: 'main',
    messages: [readCall('call_world', world)],
  }];
  const report = classifyWorkspaceReads({
    requests,
    workspace,
    sessionDir: workspace,
    denyRoots: [dir],
    armWorldRoot: world,
  });
  assert.equal(report.pass, true, JSON.stringify(report.violations));
  assert.equal(report.violationCount, 0);
  assert.equal(report.armWorldCount, 1);
  assert.equal(report.armWorldReads[0].kind, 'arm-world');
  assert.equal(report.armWorldReads[0].callId, 'call_world');
  assert.equal(report.armWorldRoot !== null, true, 'the root is recorded on the report');
  assert.equal(report.outsideCount, 1, 'the tolerated row is still recorded as outside');
});

test('a read of the evidence root outside the world still fails deny-root', (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { world, workspace } = armWorld(dir);
  mkdirSync(join(dir, 'capture'), { recursive: true });
  writeFileSync(join(dir, 'result.json'), '{}\n', 'utf8');
  writeFileSync(join(dir, 'capture', 'capture.jsonl'), '{}\n', 'utf8');
  const requests = [{
    seq: 1,
    kind: 'main',
    messages: [
      readCall('call_world', world),
      readCall('call_result', join(dir, 'result.json')),
      readCall('call_capture', join(dir, 'capture', 'capture.jsonl')),
    ],
  }];
  const report = classifyWorkspaceReads({
    requests,
    workspace,
    sessionDir: workspace,
    denyRoots: [dir],
    armWorldRoot: world,
  });
  assert.equal(report.pass, false);
  assert.equal(report.armWorldCount, 1, 'the world read is still tolerated');
  assert.equal(report.violationCount, 2);
  assert.deepEqual(report.violationKinds, ['deny-root']);
  assert.deepEqual(report.violations.map((row) => row.callId).sort(),
    ['call_capture', 'call_result'], 'both evidence-root reads are violations');
});

test('a link out of the arm world is a symlink escape', (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { world, workspace } = armWorld(dir);
  const outside = join(dir, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'secret\n', 'utf8');
  symlinkSync(outside, join(world, 'link'),
    process.platform === 'win32' ? 'junction' : undefined);
  const requests = [{
    seq: 1,
    kind: 'main',
    messages: [readCall('call_link', join(world, 'link', 'secret.txt'))],
  }];
  const report = classifyWorkspaceReads({
    requests,
    workspace,
    sessionDir: workspace,
    denyRoots: [dir],
    armWorldRoot: world,
  });
  assert.equal(report.pass, false);
  assert.equal(report.armWorldCount, 0);
  assert.equal(report.violationCount, 1);
  assert.equal(report.violations[0].kind, 'symlink-escape');
  assert.match(report.violations[0].realPath, /outside/u);
});

test('the host-cache and host-temp shapes keep their more specific kind inside the world',
  (t) => {
    const dir = scratch();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { world, workspace } = armWorld(dir);
    const hostTemp = join(world, 'tmp', 'opencode');
    mkdirSync(hostTemp, { recursive: true });
    const requests = [{
      seq: 1,
      kind: 'main',
      messages: [
        readCall('call_temp', hostTemp),
        readCall('call_world', join(world, 'home')),
      ],
    }];
    const report = classifyWorkspaceReads({
      requests,
      workspace,
      sessionDir: workspace,
      denyRoots: [dir],
      hostTempRoot: hostTemp,
      armWorldRoot: world,
    });
    assert.equal(report.pass, true, JSON.stringify(report.violations));
    assert.equal(report.hostTempCount, 1, 'the temp path keeps host-temp');
    assert.equal(report.armWorldCount, 1, 'the other world path is arm-world');
    assert.equal(report.hostTempReads[0].kind, 'host-temp');
    assert.equal(report.armWorldReads[0].kind, 'arm-world');
  });

test('without the arm-world root the same world read is a deny-root violation', (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { world, workspace } = armWorld(dir);
  const requests = [{
    seq: 1,
    kind: 'main',
    messages: [readCall('call_world', world)],
  }];
  const report = classifyWorkspaceReads({
    requests,
    workspace,
    sessionDir: workspace,
    denyRoots: [dir],
  });
  assert.equal(report.pass, false);
  assert.equal(report.armWorldCount, 0);
  assert.equal(report.violationKinds[0], 'deny-root');
});
