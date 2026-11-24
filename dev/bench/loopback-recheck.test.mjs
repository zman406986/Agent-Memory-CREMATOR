#!/usr/bin/env node
/**
 * The loopback gate's offline re-verdict (ISSUE-078; commit 5a9f0e7).
 *
 * `result.json` states the verdict a LIVE run reached. When the gate was wrong,
 * that stored verdict is stale and the run cannot be re-bought — so
 * `loopback-recheck.mjs` re-decides gate 12 over the artifacts on disk. These
 * gates pin the four things a reader of a re-verdict depends on:
 *
 *   (a) the 078 shape exactly: content that mentions loopback, a stored FAIL, and
 *       a re-verdict of PASS with 0 offending — the false positive is named, not
 *       silently dropped;
 *   (b) a request/header with a loopback `baseURL` re-verdicts FAIL and counts
 *       the offending call, so the script still says no when a run routed to the
 *       mock;
 *   (c) a bare session file is an input too, and an input holding no record at
 *       all is refused rather than passing over nothing;
 *   (d) static: the imports are `node:fs`, `node:path` and the gate — no client,
 *       no fetch, no provider module — so "offline" is a property of the file.
 *
 * Fixtures are built inline in a temp dir. Nothing here reads `scratchpad/`:
 * those files are disposable by law and must not decide a durable test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { recheck } from './loopback-recheck.mjs';

const SCRIPT = fileURLToPath(new URL('./loopback-recheck.mjs', import.meta.url));

/** The game template's own docs, quoted in a tool result (the 078 false positive). */
const DOC = 'start the preview at http://127.0.0.1:4173 and open /editor';

/** A `tool/result` session event: content, never a route. */
const toolResult = (callId, text) => ({
  type: 'tool/result', seq: 507,
  data: { message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
    content: [{ type: 'text', text }] } },
});

/** A `request/header`, the record shape that states a route. */
const requestHeader = (callId, header) => ({ type: 'request/header', seq: 12, data: { header, callId } });

/** Write a JSONL file from records. */
function jsonl(file, records) {
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

/**
 * One evidence tree in a temp dir: `stdout.ndjson`, one `session.v4.jsonl` under
 * `sessions/<arm>/<id>/`, and a `result.json` whose recorded verdict is `stored`.
 * @returns {string} the evidence dir.
 */
function evidence({ arm, stdout, session, stored }) {
  const root = mkdtempSync(join(tmpdir(), 'racoons-loopback-recheck-'));
  const sessionDir = join(root, 'sessions', `--${arm}--`, 'session-1');
  mkdirSync(sessionDir, { recursive: true });
  jsonl(join(root, 'stdout.ndjson'), stdout);
  jsonl(join(sessionDir, 'session.v4.jsonl'), session);
  writeFileSync(join(root, 'result.json'), JSON.stringify({
    arm: { name: arm },
    assertions: [{ name: 'no record names a loopback endpoint', ok: stored.ok, detail: stored.detail }],
  }));
  return root;
}

test('078 (a) content that names loopback re-verdicts PASS over a stored FAIL', () => {
  const root = evidence({
    arm: 'racoons',
    stdout: [{ type: 'tool_result', callId: 'call_A', result: DOC }],
    session: [toolResult('call_A', DOC), toolResult('call_B', DOC)],
    stored: { ok: false, detail: '5 record(s) mention 127.0.0.1' },
  });
  try {
    const outcome = recheck(root);
    assert.equal(outcome.label, 'racoons');
    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(outcome.offending, 0, 'the false positive is gone from the count');
    assert.equal(outcome.endpointFields, 0, 'content is never walked for endpoint keys');
    assert.deepEqual(outcome.stored, { ok: false, detail: '5 record(s) mention 127.0.0.1' },
      'the verdict the run stored is reported beside the new one, not overwritten');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('078 (b) a request/header routing to loopback re-verdicts FAIL and counts the call', () => {
  const root = evidence({
    arm: 'racoons',
    stdout: [],
    session: [requestHeader('call_C', { config: { baseURL: 'http://127.0.0.1:4173/v1' } })],
    stored: { ok: true, detail: null },
  });
  try {
    const outcome = recheck(root);
    assert.equal(outcome.ok, false, 'a route to the mock must still fail');
    assert.equal(outcome.offending, 1);
    assert.match(outcome.detail, /1 distinct call/u);
    assert.match(outcome.detail, /call_C/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('078 (c) a bare session file is an input, and an empty input is refused', () => {
  const root = evidence({
    arm: 'vanilla',
    stdout: [],
    session: [toolResult('call_D', DOC)],
    stored: { ok: true, detail: null },
  });
  try {
    const bare = recheck(join(root, 'sessions', '--vanilla--', 'session-1', 'session.v4.jsonl'));
    assert.equal(bare.ok, true);
    assert.equal(bare.sessionRecords, 1);
    assert.equal(bare.stored, null, 'a bare file carries no result.json verdict');
    const empty = join(root, 'empty');
    mkdirSync(empty);
    assert.throws(() => recheck(empty), /no stdout\.ndjson and no session\.v4\.jsonl/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('078 (d) the re-verdict is offline by construction: no client, no fetch, no provider', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gmu)].map((match) => match[1]);
  // `../lib/args.mjs` is dev's shared argument parser (ISSUE-072). It imports
  // `node:util` and nothing else, so the offline claim is unchanged.
  assert.deepEqual(imports, ['node:fs', 'node:path', './loopback-gate.mjs', '../shared/args.mjs']);
  for (const forbidden of ['fetch(', 'node:http', 'node:https', 'node:net', 'node:dgram', 'child_process']) {
    assert.ok(!source.includes(forbidden), `${forbidden} must not appear in an offline re-verdict`);
  }
});
