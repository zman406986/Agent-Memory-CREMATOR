/**
 * ISSUE-303: the host's own `external_directory` permission denies an outside
 * path, and the audit must not count the denied attempt as a read.
 *
 * The live vanilla segment's two outside `grep` calls each returned
 *
 *   {"error":{"type":"permission.rejected","message":"Permission denied:
 *    external_directory"},"content":[]}
 *
 * so no bytes were read, yet `classifyWorkspaceReads` counted the call input as
 * `deny-root` and the run was thrown away. The fix pairs a path-bearing call
 * with its captured result: a structured `permission.rejected` naming
 * `external_directory`, with no content, is `host-denied` and is not a
 * violation. A result that carries content, and a call with no result at all,
 * stay violations: the denial must mean no execution.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  HOST_PERMISSION_DENIED_REASON, classifyWorkspaceReads, classifyWorkspaceWrites,
  hostExternalDirectoryDenial,
} from './opencode-run.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'cremator-opencode-host-denied-'));

/** The live refusal shape, verbatim from the run's capture. */
const DENIED = JSON.stringify({
  error: { type: 'permission.rejected', message: 'Permission denied: external_directory' },
  content: [],
});

const call = (id, name, input) => ({
  role: 'assistant',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }],
});

const result = (callId, content) => ({ role: 'tool', tool_call_id: callId, content });

/** A world with the work copy and one outside directory. */
function world(t) {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'work');
  const outside = join(dir, 'outside');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'secret bytes\n', 'utf8');
  return { dir, workspace, outside };
}

const classify = (workspace, dir, messages) => classifyWorkspaceReads({
  requests: [{ seq: 9, kind: 'main', messages }],
  workspace,
  sessionDir: workspace,
  denyRoots: [dir],
});

test('a permission.rejected external_directory result is host-denied, not a violation', (t) => {
  const { dir, workspace, outside } = world(t);
  const messages = [
    { role: 'user', content: 'go' },
    call('call_grep_1', 'grep', { path: join(outside, 'first'), pattern: 'x' }),
    call('call_grep_2', 'grep', { path: join(outside, 'second'), pattern: 'x' }),
    call('call_read_ok', 'read', { path: join(workspace, 'notes.txt') }),
    result('call_grep_1', DENIED),
    result('call_grep_2', DENIED),
    result('call_read_ok', 'notes\n'),
  ];
  const report = classify(workspace, dir, messages);
  assert.equal(report.pass, true, JSON.stringify(report.violations));
  assert.equal(report.violationCount, 0);
  assert.deepEqual(report.violationKinds, []);
  assert.equal(report.hostDeniedCount, 2);
  assert.deepEqual(report.hostDenied.map((row) => row.callId), ['call_grep_1', 'call_grep_2']);
  assert.deepEqual(report.hostDenied.map((row) => row.kind), ['host-denied', 'host-denied']);
  assert.deepEqual(report.hostDenied.map((row) => row.reason),
    [HOST_PERMISSION_DENIED_REASON, HOST_PERMISSION_DENIED_REASON]);
  assert.equal(report.hostDenied[0].name, 'grep');
  assert.equal(report.hostDenied[0].key, 'path');
  assert.match(report.hostDenied[0].resolved, /outside/u);
  assert.equal(report.insideCount, 1, 'the read that ran inside is still the in-copy read');
  assert.equal(report.outsideCount, 2, 'the denied paths are still named as outside rows');
  assert.match(report.note, /host-denied/u);
  assert.match(report.note, /native `external_directory` permission denies/u);
  assert.match(report.note, /second net/u);
});

test('a denied call that nevertheless returned content stays a violation', (t) => {
  const { dir, workspace, outside } = world(t);
  const deniedThenAnswered = [
    { role: 'user', content: 'go' },
    call('call_grep', 'grep', { path: outside, pattern: 'x' }),
    result('call_grep', JSON.stringify({ output: 'secret bytes\n' })),
  ];
  const report = classify(workspace, dir, deniedThenAnswered);
  assert.equal(report.pass, false);
  assert.equal(report.hostDeniedCount, 0, 'a result with content is not the host refusal');
  assert.equal(report.violationCount, 1);
  assert.equal(report.violations[0].callId, 'call_grep');
  assert.equal(report.violations[0].kind, 'deny-root');

  const deniedShapeWithContent = [
    { role: 'user', content: 'go' },
    call('call_grep', 'grep', { path: outside, pattern: 'x' }),
    result('call_grep', JSON.stringify({
      error: { type: 'permission.rejected', message: 'Permission denied: external_directory' },
      content: ['secret bytes\n'],
    })),
  ];
  const contentReport = classify(workspace, dir, deniedShapeWithContent);
  assert.equal(contentReport.pass, false);
  assert.equal(contentReport.hostDeniedCount, 0,
    'a refusal-shaped bag beside content does not excuse the call');
  assert.equal(contentReport.violationCount, 1);
});

test('a call with no captured result is still a violation (fail closed)', (t) => {
  const { dir, workspace, outside } = world(t);
  const noResult = [
    { role: 'user', content: 'go' },
    call('call_grep', 'grep', { path: outside, pattern: 'x' }),
  ];
  const report = classify(workspace, dir, noResult);
  assert.equal(report.pass, false);
  assert.equal(report.hostDeniedCount, 0);
  assert.equal(report.violationCount, 1);
  assert.equal(report.violations[0].kind, 'deny-root');
});

test('a refusal that does not name external_directory, or is not structured, still fails', (t) => {
  const { dir, workspace, outside } = world(t);
  const otherPermission = [
    { role: 'user', content: 'go' },
    call('call_grep', 'grep', { path: outside, pattern: 'x' }),
    result('call_grep', JSON.stringify({
      error: { type: 'permission.rejected', message: 'Permission denied: edit' },
      content: [],
    })),
  ];
  const otherReport = classify(workspace, dir, otherPermission);
  assert.equal(otherReport.pass, false);
  assert.equal(otherReport.hostDeniedCount, 0);
  assert.equal(otherReport.violationCount, 1);

  const plainText = [
    { role: 'user', content: 'go' },
    call('call_grep', 'grep', { path: outside, pattern: 'x' }),
    result('call_grep', 'Permission denied: external_directory'),
  ];
  const plainReport = classify(workspace, dir, plainText);
  assert.equal(plainReport.pass, false);
  assert.equal(plainReport.hostDeniedCount, 0,
    'only the host\'s structured result is evidence of its denial');
  assert.equal(plainReport.violationCount, 1);
});

test('a relative .. escape the host denied is host-denied too', (t) => {
  const { dir, workspace } = world(t);
  const messages = [
    { role: 'user', content: 'go' },
    call('call_relative', 'grep', { path: join('..', 'outside', 'secret.txt'), pattern: 'x' }),
    result('call_relative', DENIED),
  ];
  const report = classify(workspace, dir, messages);
  assert.equal(report.pass, true, JSON.stringify(report.violations));
  assert.equal(report.violationCount, 0);
  assert.equal(report.hostDeniedCount, 1);
  assert.equal(report.relativeCount, 1, 'the input was still relative');
  assert.match(report.hostDenied[0].resolved, /outside/u);
});

test('hostExternalDirectoryDenial accepts only the live structured refusal', () => {
  assert.equal(hostExternalDirectoryDenial(DENIED), true);
  assert.equal(hostExternalDirectoryDenial(JSON.stringify({
    error: { type: 'permission.denied', message: 'Permission denied: external_directory' },
  })), true, 'the equivalent structured spelling is the same refusal');
  assert.equal(hostExternalDirectoryDenial(JSON.stringify({
    error: { type: 'permission.rejected', message: 'Permission denied: edit' },
    content: [],
  })), false);
  assert.equal(hostExternalDirectoryDenial('Permission denied: external_directory'), false);
  assert.equal(hostExternalDirectoryDenial('{"content":[]}'), false);
  assert.equal(hostExternalDirectoryDenial(null), false);
  assert.equal(hostExternalDirectoryDenial(''), false);
  const refused = {
    error: { type: 'permission.rejected', message: 'Permission denied: external_directory' },
  };
  /**
   * Any non-empty `content` is content, whatever its type: a string, a typical
   * text part, an array, a number or a boolean. The accepted empty set is
   * exactly absent/null, an empty string, an empty array and an empty object.
   */
  for (const content of [
    'secret bytes',
    { type: 'text', text: 'secret bytes' },
    ['secret bytes'],
    5,
    true,
  ]) {
    assert.equal(hostExternalDirectoryDenial(JSON.stringify({ ...refused, content })), false,
      `content ${JSON.stringify(content)} is content, not a refusal`);
  }
  assert.equal(hostExternalDirectoryDenial(JSON.stringify({
    ...refused, output: ['secret bytes'],
  })), false, 'a non-empty array output is content');
  assert.equal(hostExternalDirectoryDenial(JSON.stringify({
    ...refused, text: ['secret bytes'],
  })), false, 'a non-empty array text is content');
  assert.equal(hostExternalDirectoryDenial(JSON.stringify({ ...refused, output: 0 })), false,
    'a number output is content');
  assert.equal(hostExternalDirectoryDenial(JSON.stringify({ ...refused, text: false })), false,
    'a boolean text is content');
  for (const empty of [null, '', [], {}]) {
    assert.equal(hostExternalDirectoryDenial(JSON.stringify({ ...refused, content: empty })), true,
      `content ${JSON.stringify(empty)} is empty, so the refusal stands`);
  }
  assert.equal(hostExternalDirectoryDenial(JSON.stringify(refused)), true,
    'an absent content field is empty');
});

test('a run with only denied probes can pass with a non-zero host-denied count', (t) => {
  const { dir, workspace, outside } = world(t);
  const report = classify(workspace, dir, [
    { role: 'user', content: 'go' },
    call('probe_1', 'grep', { path: outside, pattern: 'x' }),
    call('probe_2', 'grep', { path: join(outside, 'second'), pattern: 'x' }),
    result('probe_1', DENIED),
    result('probe_2', DENIED),
  ]);
  assert.equal(report.pass, true, JSON.stringify(report.violations));
  assert.equal(report.violationCount, 0);
  assert.equal(report.hostDeniedCount, 2);
  assert.equal(report.hostDenied.length, 2);
  assert.equal(report.outsideCount, 2);
});

const classifyWrites = (workspace, dir, messages) => classifyWorkspaceWrites({
  requests: [{ seq: 9, kind: 'main', messages }],
  workspace,
  sessionDir: workspace,
  denyRoots: [dir],
});

test('a native-denied outside write/edit is host-denied, not a write violation', (t) => {
  const { dir, workspace, outside } = world(t);
  const report = classifyWrites(workspace, dir, [
    { role: 'user', content: 'go' },
    call('call_write', 'write', { path: join(outside, 'report.md'), content: 'report\n' }),
    call('call_edit', 'edit', {
      path: join(outside, 'notes.md'), oldString: 'a', newString: 'b',
    }),
    call('call_inside', 'write', { path: join(workspace, 'inside.md'), content: 'inside\n' }),
    result('call_write', DENIED),
    result('call_edit', DENIED),
    result('call_inside', 'written\n'),
  ]);
  assert.equal(report.pass, true, JSON.stringify(report.violations));
  assert.equal(report.violationCount, 0);
  assert.deepEqual(report.violationKinds, []);
  assert.equal(report.hostDeniedCount, 2);
  assert.deepEqual(report.hostDenied.map((row) => row.callId), ['call_write', 'call_edit']);
  assert.deepEqual(report.hostDenied.map((row) => row.kind), ['host-denied', 'host-denied']);
  assert.deepEqual(report.hostDenied.map((row) => row.reason),
    [HOST_PERMISSION_DENIED_REASON, HOST_PERMISSION_DENIED_REASON]);
  assert.equal(report.hostDenied[0].name, 'write');
  assert.equal(report.hostDenied[1].name, 'edit');
  assert.match(report.hostDenied[0].resolved, /outside/u);
  assert.equal(report.insideCount, 1);
  assert.equal(report.outsideCount, 2);
  assert.match(report.detection, /host-denied/u);
  assert.match(report.detection, /native `external_directory` permission denies/u);
});

test('a denied write that returned content, and one with no result, stay violations', (t) => {
  const { dir, workspace, outside } = world(t);
  const withContent = classifyWrites(workspace, dir, [
    { role: 'user', content: 'go' },
    call('call_write', 'write', { path: join(outside, 'report.md'), content: 'report\n' }),
    result('call_write', JSON.stringify({ output: 'report\n' })),
  ]);
  assert.equal(withContent.pass, false);
  assert.equal(withContent.hostDeniedCount, 0);
  assert.equal(withContent.violationCount, 1);
  assert.equal(withContent.violations[0].kind, 'deny-root');

  const withContentValue = classifyWrites(workspace, dir, [
    { role: 'user', content: 'go' },
    call('call_write', 'write', { path: join(outside, 'report.md'), content: 'report\n' }),
    result('call_write', JSON.stringify({
      error: { type: 'permission.rejected', message: 'Permission denied: external_directory' },
      content: 'secret bytes',
    })),
  ]);
  assert.equal(withContentValue.pass, false,
    'a string content beside the error bag is still an executed call');
  assert.equal(withContentValue.hostDeniedCount, 0);
  assert.equal(withContentValue.violationCount, 1);

  const noResult = classifyWrites(workspace, dir, [
    { role: 'user', content: 'go' },
    call('call_write', 'write', { path: join(outside, 'report.md'), content: 'report\n' }),
  ]);
  assert.equal(noResult.pass, false, 'a call with no result is still a violation');
  assert.equal(noResult.hostDeniedCount, 0);
  assert.equal(noResult.violationCount, 1);

  const otherDenial = classifyWrites(workspace, dir, [
    { role: 'user', content: 'go' },
    call('call_write', 'write', { path: join(outside, 'report.md'), content: 'report\n' }),
    result('call_write', JSON.stringify({
      error: { type: 'permission.rejected', message: 'Permission denied: edit' },
      content: [],
    })),
  ]);
  assert.equal(otherDenial.pass, false,
    'only the external_directory refusal covers an outside write');
  assert.equal(otherDenial.hostDeniedCount, 0);
  assert.equal(otherDenial.violationCount, 1);
});
