#!/usr/bin/env node
/**
 * The bench's opencode wire capture (ISSUE-213/214 bench wiring).
 *
 * Offline only: no host binary, no API key, no network. Every case mounts the
 * plugin against a fake `context.session.hook` and reads the JSONL file back.
 * The last case spawns a child process to prove the process-exit flush, with the
 * timer set to ten minutes so exit is the only thing that can write the line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CAPTURE_PLUGIN_ID, createCapturePlugin } from './opencode-capture-plugin.mjs';
import { readCaptureLog } from './opencode-run.mjs';

const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url));
const MODULE_PATH = join(BENCH_DIR, 'opencode-capture-plugin.mjs');
const URL_UNDER_TEST = 'https://host.test/v1/chat/completions';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'racoons-capture-'));
}

/** Mount against the smallest host shape: `session.hook` returns a registration. */
async function mount(plugin) {
  const hooks = new Map();
  const cleanup = await plugin.setup({
    session: {
      hook: async (name, callback) => {
        hooks.set(name, callback);
        return { dispose: async () => { hooks.delete(name); } };
      },
    },
  });
  const hook = hooks.get('http.request');
  assert.equal(typeof hook, 'function', 'setup registered http.request');
  return { hook, cleanup };
}

function input(request, overrides = {}) {
  return {
    sessionID: 'session-1',
    agent: 'build',
    model: { providerID: 'deepseek', modelID: 'deepseek-chat' },
    kind: 'primary',
    request,
    ...overrides,
  };
}

/** Flush until no record is in flight, queued or waiting, and fail if it never is. */
async function settle(plugin) {
  for (let tick = 0; tick < 400; tick += 1) {
    plugin.captureFlush();
    if (plugin.captureSummary().pending === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`capture did not settle: ${JSON.stringify(plugin.captureSummary())}`);
}

function readLines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('capture: a JSON body round-trips byte-for-byte and hashes correctly', async () => {
  const dir = scratch();
  const logPath = join(dir, 'requests.jsonl');
  // Append-only: a line already in the file survives.
  writeFileSync(logPath, '{"sentinel":true}\n', 'utf8');
  const plugin = createCapturePlugin({ logPath, flushIntervalMs: 10 * 60 * 1000 });
  const body = '{"model":"m","messages":[{"role":"user","content":"héllo"}]}';
  const request = new Request(URL_UNDER_TEST, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trace': 't-1' },
    body,
  });
  try {
    const { hook, cleanup } = await mount(plugin);
    hook(input(request, { kind: 'primary' }));
    await settle(plugin);
    await cleanup();
    const lines = readLines(logPath);
    assert.equal(lines.length, 2, 'sentinel plus one capture line');
    assert.deepEqual(lines[0], { sentinel: true });
    const line = lines[1];
    assert.equal(line.seq, 1);
    assert.equal(Number.isNaN(Date.parse(line.at)), false, 'at is an ISO timestamp');
    assert.equal(line.sessionID, 'session-1');
    assert.equal(line.agent, 'build');
    assert.deepEqual(line.model, { providerID: 'deepseek', modelID: 'deepseek-chat' });
    assert.equal(line.kind, 'primary');
    assert.equal(line.method, 'POST');
    assert.equal(line.url, URL_UNDER_TEST);
    assert.equal(line.headers['content-type'], 'application/json');
    assert.equal(line.headers['x-trace'], 't-1');
    assert.equal(line.bodyReadable, true);
    assert.equal(line.body, body, 'body bytes round-trip');
    assert.equal(line.bodyBytes, Buffer.byteLength(body, 'utf8'));
    assert.equal(line.bodySha256, sha256(Buffer.from(body, 'utf8')));
    assert.equal(line.truncated, false);
    // The original request was never read or mutated by the hook.
    assert.equal(request.bodyUsed, false);
    assert.equal(await request.text(), body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture: a 4 MiB body is recorded with the right byte count and hash', async () => {
  const dir = scratch();
  const plugin = createCapturePlugin({ logPath: join(dir, 'requests.jsonl'), flushIntervalMs: 10 * 60 * 1000 });
  const body = 'a'.repeat(4 * 1024 * 1024);
  const bytes = Buffer.from(body, 'utf8');
  const request = new Request(URL_UNDER_TEST, { method: 'POST', body });
  try {
    const { hook, cleanup } = await mount(plugin);
    hook(input(request));
    await settle(plugin);
    await cleanup();
    const [line] = readLines(join(dir, 'requests.jsonl'));
    assert.equal(line.bodyBytes, bytes.length);
    assert.equal(line.bodyBytes, 4 * 1024 * 1024);
    assert.equal(line.bodySha256, sha256(bytes));
    assert.equal(line.truncated, false);
    assert.equal(line.body.length, body.length);
    const summary = plugin.captureSummary();
    assert.equal(summary.lines, 1);
    assert.equal(summary.truncatedLines, 0);
    assert.equal(summary.bytes, Buffer.byteLength(`${JSON.stringify(line)}\n`, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture: a body over maxBodyBytes is marked truncated and keeps its line', async () => {
  const dir = scratch();
  const logPath = join(dir, 'requests.jsonl');
  const plugin = createCapturePlugin({ logPath, maxBodyBytes: 1024, flushIntervalMs: 10 * 60 * 1000 });
  const body = 'x'.repeat(4096);
  const request = new Request(URL_UNDER_TEST, { method: 'POST', body });
  try {
    const { hook, cleanup } = await mount(plugin);
    hook(input(request));
    await settle(plugin);
    await cleanup();
    const lines = readLines(logPath);
    assert.equal(lines.length, 1, 'the truncated body keeps its line');
    const [line] = lines;
    assert.equal(line.truncated, true);
    assert.equal(line.bodyBytes, 4096, 'the full byte count is kept');
    assert.equal(line.bodySha256, sha256(Buffer.from(body, 'utf8')), 'the hash covers the full body');
    assert.equal(line.body, 'x'.repeat(1024));
    assert.equal(line.bodyRecordedBytes, 1024);
    const summary = plugin.captureSummary();
    assert.equal(summary.truncatedLines, 1);
    assert.equal(summary.pending, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture: a non-UTF-8 body is recorded as base64', async () => {
  const dir = scratch();
  const logPath = join(dir, 'requests.jsonl');
  const plugin = createCapturePlugin({ logPath, flushIntervalMs: 10 * 60 * 1000 });
  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
  const request = new Request(URL_UNDER_TEST, { method: 'POST', body: bytes });
  try {
    const { hook, cleanup } = await mount(plugin);
    hook(input(request));
    await settle(plugin);
    await cleanup();
    const [line] = readLines(logPath);
    assert.equal(line.body, null);
    assert.equal(line.bodyBase64, bytes.toString('base64'));
    assert.equal(line.bodyBytes, bytes.length);
    assert.equal(line.bodySha256, sha256(bytes));
    assert.equal(line.bodyReadable, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture: authorization and cookie values never reach the file; presence is recorded', async () => {
  const dir = scratch();
  const logPath = join(dir, 'requests.jsonl');
  const plugin = createCapturePlugin({ logPath, flushIntervalMs: 10 * 60 * 1000 });
  const secret = 'sk-live-NEVER-WRITE-THIS';
  const cookie = 'session=NEVER-WRITE-THIS-EITHER';
  const withSecrets = new Request(URL_UNDER_TEST, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, cookie, 'x-trace': 't-2' },
    body: '{}',
  });
  const withoutSecrets = new Request(URL_UNDER_TEST, { method: 'POST', body: '{}' });
  try {
    const { hook, cleanup } = await mount(plugin);
    hook(input(withSecrets));
    hook(input(withoutSecrets, { kind: 'title' }));
    await settle(plugin);
    await cleanup();
    const raw = readFileSync(logPath, 'utf8');
    assert.equal(raw.includes(secret), false, 'authorization value is absent');
    assert.equal(raw.includes('NEVER-WRITE-THIS-EITHER'), false, 'cookie value is absent');
    const [first, second] = readLines(logPath);
    assert.deepEqual(first.headers.authorization, { present: true });
    assert.deepEqual(first.headers.cookie, { present: true });
    assert.equal(first.headers['x-trace'], 't-2');
    assert.deepEqual(second.headers.authorization, { present: false });
    assert.deepEqual(second.headers.cookie, { present: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture: a request whose body was already read does not throw and keeps its line', async () => {
  const dir = scratch();
  const logPath = join(dir, 'requests.jsonl');
  const plugin = createCapturePlugin({ logPath, flushIntervalMs: 10 * 60 * 1000 });
  const request = new Request(URL_UNDER_TEST, { method: 'POST', body: 'already gone' });
  await request.text();
  try {
    const { hook, cleanup } = await mount(plugin);
    assert.doesNotThrow(() => hook(input(request)));
    await settle(plugin);
    await cleanup();
    const [line] = readLines(logPath);
    assert.equal(line.seq, 1);
    assert.equal(line.bodyReadable, false);
    assert.equal(line.bodyBytes, 0);
    assert.equal(line.bodySha256, null);
    assert.equal(line.body, null);
    assert.equal(line.truncated, false);
    assert.equal(typeof line.bodyError, 'string');
    assert.equal(plugin.captureSummary().errors, 0, 'a consumed body is data, not a capture error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture: two concurrent hooks produce two ordered, complete lines', async () => {
  const dir = scratch();
  const logPath = join(dir, 'requests.jsonl');
  const plugin = createCapturePlugin({ logPath, flushIntervalMs: 10 * 60 * 1000 });
  const big = 'b'.repeat(4 * 1024 * 1024);
  const small = 'small-body';
  const first = new Request(URL_UNDER_TEST, { method: 'POST', body: big });
  const second = new Request(URL_UNDER_TEST, { method: 'POST', body: small });
  try {
    const { hook, cleanup } = await mount(plugin);
    // Not awaited: the two body reads race, and the later one may finish first.
    hook(input(first));
    hook(input(second, { kind: 'title' }));
    await settle(plugin);
    await cleanup();
    const lines = readLines(logPath);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => line.seq), [1, 2], 'seq order is file order');
    assert.equal(lines[0].kind, 'primary');
    assert.equal(lines[0].body, big);
    assert.equal(lines[1].kind, 'title');
    assert.equal(lines[1].body, small);
    for (const line of lines) {
      assert.equal(line.bodyBytes, Buffer.byteLength(line.body, 'utf8'));
      assert.equal(line.bodySha256, sha256(Buffer.from(line.body, 'utf8')));
    }
    assert.equal(plugin.captureSummary().lines, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture: a log that cannot be written is recorded, never thrown', async () => {
  const dir = scratch();
  const logPath = join(dir, 'not-a-file');
  mkdirSync(logPath);
  const plugin = createCapturePlugin({ logPath, flushIntervalMs: 10 * 60 * 1000 });
  const request = new Request(URL_UNDER_TEST, { method: 'POST', body: 'lost-line' });
  try {
    const { hook, cleanup } = await mount(plugin);
    assert.doesNotThrow(() => hook(input(request)));
    await settle(plugin);
    await cleanup();
    const errors = plugin.captureErrors();
    assert.ok(errors.length >= 1, 'the flush failure is in memory');
    assert.equal(errors[0].kind, 'flush');
    assert.equal(typeof errors[0].message, 'string');
    assert.ok(errors[0].lines >= 1);
    const summary = plugin.captureSummary();
    assert.ok(summary.errors >= 1);
    assert.equal(summary.lines, 0);
    assert.equal(summary.dropped, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture: queued lines flush at process exit, not only on the timer', () => {
  const dir = scratch();
  const logPath = join(dir, 'requests.jsonl');
  const moduleUrl = pathToFileURL(MODULE_PATH).href;
  const script = `
import { createCapturePlugin } from ${JSON.stringify(moduleUrl)};
const plugin = createCapturePlugin({ logPath: ${JSON.stringify(logPath)}, flushIntervalMs: 600000 });
const hooks = new Map();
await plugin.setup({ session: { hook: async (name, callback) => {
  hooks.set(name, callback);
  return { dispose: async () => {} };
} } });
hooks.get('http.request')({
  sessionID: 'exit-session', agent: 'build', model: 'm', kind: 'primary',
  request: new Request('https://host.test/v1/chat', { method: 'POST', body: 'exit-flush-body' }),
});
await new Promise((resolve) => setTimeout(resolve, 100));
process.exit(0);
`;
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    assert.equal(child.status, 0, child.stderr);
    const lines = readLines(logPath);
    assert.equal(lines.length, 1, 'the exit flush wrote the queued line');
    assert.equal(lines[0].body, 'exit-flush-body');
    assert.equal(lines[0].sessionID, 'exit-session');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture: a periodic flush writes the summary, so an exit without an exit handler is not blocked for a lost summary', () => {
  const dir = scratch();
  const logPath = join(dir, 'requests.jsonl');
  const summaryPath = `${logPath}.summary.json`;
  const moduleUrl = pathToFileURL(MODULE_PATH).href;
  // The timer flushes the line and the summary; the child then removes every
  // exit listener before calling process.exit, so no exit handler can write the
  // sidecar. The summary the reader sees is the periodic flush's own.
  const script = `
import { existsSync, readFileSync } from 'node:fs';
import { createCapturePlugin } from ${JSON.stringify(moduleUrl)};
const plugin = createCapturePlugin({ logPath: ${JSON.stringify(logPath)}, flushIntervalMs: 20 });
const hooks = new Map();
await plugin.setup({ session: { hook: async (name, callback) => {
  hooks.set(name, callback);
  return { dispose: async () => {} };
} } });
hooks.get('http.request')({
  sessionID: 'periodic-session', agent: 'build', model: 'm', kind: 'primary',
  request: new Request('https://host.test/v1/chat', { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) }),
});
const deadline = Date.now() + 15000;
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  let lines = null;
  try { lines = JSON.parse(readFileSync(${JSON.stringify(summaryPath)}, 'utf8')).lines; }
  catch { lines = null; }
  if (lines === 1) break;
  if (Date.now() > deadline) { process.exit(3); }
}
process.removeAllListeners('exit');
process.exit(0);
`;
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(existsSync(summaryPath), true, 'the periodic flush wrote the sidecar');
    const lines = readLines(logPath);
    assert.equal(lines.length, 1, 'the periodic flush wrote the line');
    assert.equal(lines[0].body, JSON.stringify({ model: 'm', messages: [] }));
    const read = readCaptureLog(logPath);
    assert.equal(read.summaryFrom, 'plugin-exit-summary', 'the fresh sidecar is trusted');
    assert.equal(read.summary.summaryFresh, true);
    assert.equal(read.summary.droppedKnown, true);
    assert.equal(read.summary.incomplete, false, JSON.stringify(read.summary.completeness));
    assert.equal(read.blocked, false, 'a fresh periodic summary must not block the citation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture: a bodyless request keeps its line and is not a body error', async () => {
  const dir = scratch();
  const logPath = join(dir, 'requests.jsonl');
  const plugin = createCapturePlugin({ logPath, flushIntervalMs: 10 * 60 * 1000 });
  // The host's `GET /models` has no body: `clone.body === null`.
  const request = new Request('https://host.test/v1/models', { method: 'GET' });
  try {
    const { hook, cleanup } = await mount(plugin);
    hook(input(request, { kind: null }));
    await settle(plugin);
    await cleanup();
    const [line] = readLines(logPath);
    assert.equal(line.method, 'GET');
    assert.equal(line.bodyReadable, false);
    assert.equal(line.bodyBytes, 0);
    assert.equal(line.bodySha256, null);
    assert.equal(line.body, null);
    assert.equal(line.bodyless, true);
    assert.equal(line.bodyError, undefined, 'a bodyless request is data, not an error');
    assert.equal(line.truncated, false);
    assert.equal(plugin.captureSummary().errors, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture: an exit with a body read in flight is an incomplete capture, and the reader blocks', () => {
  const dir = scratch();
  const logPath = join(dir, 'requests.jsonl');
  const moduleUrl = pathToFileURL(MODULE_PATH).href;
  // No sleep between the hook and exit: the body read is still in flight, so the
  // exit flush has nothing to drain and the summary records it as `pending`.
  const script = `
import { writeFileSync } from 'node:fs';
import { createCapturePlugin } from ${JSON.stringify(moduleUrl)};
const plugin = createCapturePlugin({ logPath: ${JSON.stringify(logPath)}, flushIntervalMs: 600000 });
const hooks = new Map();
await plugin.setup({ session: { hook: async (name, callback) => {
  hooks.set(name, callback);
  return { dispose: async () => {} };
} } });
// The loader registers its summary after the plugin's own exit flush.
process.once('exit', () => {
  writeFileSync(${JSON.stringify(`${logPath}.summary.json`)},
    \`\${JSON.stringify(plugin.captureSummary())}\\n\`);
});
hooks.get('http.request')({
  sessionID: 'in-flight-session', agent: 'build', model: 'm', kind: 'primary',
  request: new Request('https://host.test/v1/chat', { method: 'POST', body: 'in-flight-body' }),
});
process.exit(0);
`;
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    assert.equal(child.status, 0, child.stderr);
    const read = readCaptureLog(logPath);
    assert.equal(read.summary.completeness.pending >= 1, true,
      JSON.stringify(read.summary.completeness));
    assert.equal(read.summary.incomplete, true, JSON.stringify(read.summary.completeness));
    assert.equal(read.blocked, true, 'an in-flight loss must block the citation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture: a key split across read chunks is still redacted', async () => {
  const dir = scratch();
  const logPath = join(dir, 'requests.jsonl');
  const key = 'sk-racoons-SPLIT-SENTINEL-0123456789';
  const plugin = createCapturePlugin({
    logPath, redactValues: [key], flushIntervalMs: 10 * 60 * 1000,
  });
  const encoder = new TextEncoder();
  // The stream enqueues the key across three chunks, so no one read holds all
  // of it. A redactor that only scans one chunk at a time would leave the tail.
  const parts = ['prefix-', key.slice(0, 6), key.slice(6, 17), key.slice(17), '-suffix'];
  const stream = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  const request = new Request(URL_UNDER_TEST, {
    method: 'POST', body: stream, duplex: 'half',
  });
  try {
    const { hook, cleanup } = await mount(plugin);
    hook(input(request));
    await settle(plugin);
    await cleanup();
    const fileText = readFileSync(logPath, 'utf8');
    assert.equal(fileText.includes(key), false);
    const [line] = readLines(logPath);
    assert.equal(line.body, 'prefix-<redacted>-suffix');
    assert.equal(line.redactions, 1);
    assert.equal(line.bodyBytes, Buffer.byteLength(line.body, 'utf8'));
    assert.equal(line.bodySha256, sha256(Buffer.from(line.body, 'utf8')));
    assert.equal(line.rawBodyBytes, Buffer.byteLength(parts.join(''), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture: the mounted object carries the id and the observation methods', async () => {
  const dir = scratch();
  const plugin = createCapturePlugin({ logPath: join(dir, 'requests.jsonl') });
  try {
    assert.equal(plugin.id, CAPTURE_PLUGIN_ID);
    assert.equal(typeof plugin.setup, 'function');
    assert.equal(typeof plugin.captureErrors, 'function');
    const summary = plugin.captureSummary();
    assert.deepEqual(Object.keys(summary).sort(),
      ['bytes', 'dropped', 'errors', 'lines', 'pending', 'redactions', 'truncatedLines']);
    assert.deepEqual(summary, { lines: 0, bytes: 0, errors: 0, truncatedLines: 0,
      redactions: 0, pending: 0, dropped: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture: a shell/env-like tool result cannot carry the key into the log', async () => {
  const dir = scratch();
  const logPath = join(dir, 'requests.jsonl');
  const key = 'sk-racoons-SENTINEL-0123456789abcdef';
  const plugin = createCapturePlugin({
    logPath, redactValues: [key], flushIntervalMs: 10 * 60 * 1000,
  });
  // The shape a model gets when it asks a shell for its environment. The key is
  // the value the child env carries; the observer must replace it in the
  // request body the tool result becomes.
  const body = JSON.stringify({
    model: 'deepseek-flash',
    messages: [
      { role: 'user', content: 'Show me the environment.' },
      { role: 'assistant', content: null, tool_calls: [{
        id: 'call_env', type: 'function', function: { name: 'shell', arguments: '{}' },
      }] },
      { role: 'tool', tool_call_id: 'call_env',
        content: `DEEPSEEK_API_KEY=${key}\nPATH=C:\\bin\nOPENAI_API_KEY=other` },
    ],
  });
  const url = `${URL_UNDER_TEST}?key=${key}`;
  const request = new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  try {
    const { hook, cleanup } = await mount(plugin);
    hook(input(request));
    await settle(plugin);
    await cleanup();
    const fileText = readFileSync(logPath, 'utf8');
    assert.equal(fileText.includes(key), false, 'the key bytes are not in the log');
    const [line] = readLines(logPath);
    assert.equal(line.body.includes(key), false, 'the captured body is redacted');
    assert.match(line.body, /DEEPSEEK_API_KEY=<redacted>/u);
    assert.equal(line.url.includes(key), false, 'the captured URL is redacted');
    assert.match(line.url, /key=<redacted>/u);
    assert.equal(line.redactions, 1, 'the body carries one replacement');
    assert.equal(line.urlRedactions, 1, 'the URL carries one replacement');
    assert.equal(line.rawBodyBytes, Buffer.byteLength(body, 'utf8'));
    assert.equal(line.bodyBytes, Buffer.byteLength(line.body, 'utf8'));
    assert.equal(line.bodySha256, sha256(Buffer.from(line.body, 'utf8')));
    assert.equal(plugin.captureSummary().redactions, 2);
    // The redacted line is still a readable capture: the reader parses it and
    // finds no key, so the removal checks see the same shape with a placeholder.
    const read = readCaptureLog(logPath);
    assert.equal(read.blocked, false, JSON.stringify(read.problems));
    assert.equal(read.summary.redactions, 2);
    assert.equal(read.rows.length, 1);
    assert.equal(JSON.stringify(read.rows[0]).includes(key), false);
    assert.equal(request.bodyUsed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
