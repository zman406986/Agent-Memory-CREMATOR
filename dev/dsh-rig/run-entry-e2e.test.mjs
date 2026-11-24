/**
 * The entry-lane E2E as a `node --test` gate (ISSUE-058 chunk P3d).
 *
 * `run-entry-e2e.mjs` is the runner: it writes its own scenario, drives ONE real
 * `dsh` process through the loopback mock, and asserts the lane from the
 * evidence. This file is only the gate around it, so a caller can name the lane
 * by test name:
 *
 *   node --test dev/dsh-rig/run-entry-e2e.test.mjs
 *
 * What it proves, all from the evidence of a single ~5-second session: the floor
 * gate (over-floor asked, under-floor silent), keep-all rewind, forgetall and
 * keeplines as one atomic rewind+append each with the marker identity checked
 * and printed, byte-exact recall of a forgotten body, and prefix discipline
 * across every apply. A second run (`E2E_ENTRY_REFUSE=1`) proves the fail-open
 * leg by name (ISSUE-181 4a): an invalid answer is refused, the result keeps
 * its bytes and id, the ask exchange is collapsed, and the task reaches its
 * last step. Everything that does NOT need the full stack — journal row
 * shape, the retry sequencing, answer-array order, marker wording — lives in
 * the fast unit tests instead (`mock-messages.test.mjs`,
 * `packages/adapters/dsh/test/entry-ask.test.ts`,
 * `packages/adapters/dsh/test/mount-entry.test.ts`).
 *
 * Non-vacuity: the runner takes `E2E_FLOOR_BYTES` and `E2E_ENTRY_REFUSE`, which
 * move the knobs the gate depends on. The second test below drives the floor
 * hook and requires the runner to FAIL by name, so a green run here can never be
 * a run whose gate never fired. The refusal tests below drive the refusal hook
 * green, then feed synthetic evidence in which the refusal was ignored and
 * require each named check to fail.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertEntryLane } from './run-entry-e2e.mjs';

const RUNNER = fileURLToPath(new URL('./run-entry-e2e.mjs', import.meta.url));
const RECALL_CHECK = 'recall after a forget returns the original bytes, byte-exact';

// The three lane tests below drive a real `dsh` process, so they are opt-in:
// set E2E_ENTRY=1 to run them. The assertions over synthetic evidence in the
// rest of the file are pure and stay in the default run.
const E2E = process.env.E2E_ENTRY === '1'
  ? {}
  : { skip: 'opt-in: set E2E_ENTRY=1 to drive a real dsh process' };

/** One runner invocation, with an explicit environment. */
function runEntryE2E(env = {}) {
  const child = spawnSync(process.execPath, [RUNNER], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ...env },
    // The runner resolves its evidence dir from its own location, not the cwd.
    cwd: join(RUNNER, '..', '..', '..'),
  });
  return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}

test('the entry lane holds end to end: floor gate, keep-all, forget, recall, prefix',
  { timeout: 300_000, ...E2E },
  () => {
    const run = runEntryE2E();
    assert.equal(run.status, 0,
      `entry E2E failed:\n${run.stdout}\n${run.stderr}`);
    // Every assertion the runner makes passed, and it says how many.
    const summary = /entry-e2e: (\d+)\/(\d+) assertions passed in (\d+) ms/u.exec(run.stdout);
    assert.ok(summary !== null, `no assertion summary in:\n${run.stdout}`);
    assert.equal(summary[1], summary[2], 'every entry assertion passed');
    assert.ok(Number(summary[1]) >= 11,
      `the lane is under-covered: only ${String(summary[1])} assertions ran`);
    // The identity's every term is printed — Phase R's converter reads these.
    assert.match(run.stdout, /identity \S+ \(forgetall\) landed=\d+ = kept \d+ \+ gaps \d+ x marker \d+ \+ summary \d+ \+ framing 0/u,
      'the forgetall identity prints every term');
    assert.match(run.stdout, /identity \S+ \(keeplines\) landed=\d+ = kept \d+ \+ gaps \d+ x marker \d+ \+ summary \d+ \+ framing 0/u,
      'the keeplines identity prints every term');
    // The run stays in the lean envelope the owner set (3 minutes, never hours).
    assert.ok(Number(summary[3]) < 180_000,
      `the E2E took ${summary[3]} ms, over the 180 s envelope`);
  });

test('the E2E fails by name when the floor gate is moved out of reach',
  { timeout: 300_000, ...E2E },
  () => {
    // The perturbation: every result falls under the floor, so nothing is asked.
    const run = runEntryE2E({ E2E_FLOOR_BYTES: '40000' });
    assert.equal(run.status, 1, `a dead gate must fail the runner:\n${run.stdout}`);
    assert.match(run.stdout, /FAIL exactly the over-floor results were asked/u,
      'the first failure names the floor gate');
    assert.match(run.stdout, /saw 0 entry-ask line\(s\)|expected 3 entry-ask lines, saw 0/u,
      'and names the missing asks');
  });

test('the entry lane fails open on an invalid answer: kept, collapsed, task continues (ISSUE-181 4a)',
  { timeout: 300_000, ...E2E },
  () => {
    // The refusal leg: the mock serves an action the grammar does not offer to
    // the first ask. The run must stay green AND assert the refusal by name —
    // before 4a the same run was green while the entry asks hard-failed.
    const run = runEntryE2E({ E2E_ENTRY_REFUSE: '1' });
    assert.equal(run.status, 0, `the refusal leg failed:\n${run.stdout}\n${run.stderr}`);
    const summary = /entry-e2e: (\d+)\/(\d+) assertions passed in (\d+) ms/u.exec(run.stdout);
    assert.ok(summary !== null, `no assertion summary in:\n${run.stdout}`);
    assert.equal(summary[1], summary[2], 'every entry assertion passed');
    assert.ok(Number(summary[1]) >= 11,
      `the refusal leg is under-covered: only ${String(summary[1])} assertions ran`);
    // Each fact is a check of its own, so deleting one is visible right here.
    assert.match(run.stdout, /^ok {3}the invalid entry answer was refused by name/mu,
      'the run names the refusal');
    assert.match(run.stdout, /^ok {3}the refused result kept its bytes and id on the live surface/mu,
      'the run names the untouched surface');
    assert.match(run.stdout, /^ok {3}the refused ask exchange was collapsed and the task ran to its last step/mu,
      'the run names the task continuing');
  });

// ── the crossed recall, which no healthy run can produce ──────────────────

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ID_A = `recall:sha256:${'a'.repeat(64)}`;
const ID_B = `recall:sha256:${'b'.repeat(64)}`;
const ID_C = `recall:sha256:${'c'.repeat(64)}`;

/** A body of numbered lines wide enough to clear the 512-byte floor. */
function body(tag, lines) {
  let text = '';
  for (let index = 1; index <= lines; index += 1) {
    text += `${tag} ${String(index)} ${'x'.repeat(70)}\r\n`;
  }
  return Buffer.from(text, 'utf8');
}

/** One `tool/result` event as the session log writes it. */
function resultEvent(seq, callId, bytes, surfaceOp = 'append') {
  return { seq, type: 'tool/result', surfaceOp,
    data: { message: { source: { callId }, content: [{ type: 'text', text: bytes.toString('utf8') }] } } };
}

/** One `entry-ask` journal row. */
function askLine(callId, action, summary) {
  return {
    kind: 'entry-ask', eventId: `dsh:synthetic:result:${callId}`, callId, action,
    ...(summary === null ? {} : { summary }), retried: false, usage: { inputTokens: 10 },
  };
}

/** One `entry-apply` journal row. */
function applyLine(callId, action, exchangeSeq, resultSeq) {
  return {
    kind: 'entry-apply', eventId: `dsh:synthetic:result:${callId}`, callId, action,
    status: resultSeq === null ? 'rewound' : 'landed', exchangeSeq, resultSeq,
    appends: resultSeq === null ? 1 : 2,
  };
}

/** One ledger recall record, as `inspect-ledger` returns it. */
function recallRecord(recallId, callId, bytes) {
  return {
    status: 'ok', recallId, sourceSha256: sha256(bytes), restoredSha256: sha256(bytes),
    restoredBytes: bytes.length, restoredText: bytes.toString('utf8'),
    parts: [{ nodeId: `dsh:synthetic:result:${callId}`, byteLength: bytes.length, removedRanges: [] }],
  };
}

/**
 * One coherent evidence set for `assertEntryLane`: four landed results (one
 * under the floor, one keep-all, two forgotten), the two shaped turns whose
 * markers are the units' receipts, and the recall records a ledger read would
 * return. `crossed` swaps a record's body for the OTHER unit's, which is the
 * case the check exists to refuse.
 */
function syntheticEvidence({ crossed = null, truncated = false, sabotage = null } = {}) {
  const small = body('small', 2);
  const a = body('alpha', 24);
  const b = body('beta', 24);
  const keep = body('gamma', 24);
  const markerA = `[racoons] kept 0 of 24 lines · necromancy ${ID_A}\n`;
  const keptHead = b.subarray(0, b.indexOf(Buffer.from('beta 5 ', 'utf8')));
  const markerB = `[racoons] kept lines 1–4 of 24 · ${String(b.length - keptHead.length)} bytes dropped · necromancy ${ID_B}\n`;
  const turnA = `an old numbered listing\n\n${markerA}`;
  // `sabotage` writes one byte that is neither summary, marker, nor kept text:
  // the framing term must catch it. It is the non-vacuity probe for the
  // identity, the same way the floor override is the probe for the gate.
  const extra = sabotage === 'framing' ? 'Z' : '';
  const turnB = `kept the head of the listing\n\n${extra}${keptHead.toString('utf8')}${markerB}`;
  const ask = askLine;
  const applied = applyLine;
  const record = recallRecord;
  const records = [record(ID_A, 'rig_a', a), record(ID_B, 'rig_b', b)];
  if (crossed === 'bytes') {
    // A's id answers with B's archived bytes: the ids and bodies are crossed.
    records[0] = { ...record(ID_A, 'rig_b', b), recallId: ID_A };
  }
  if (crossed === 'source') {
    // A's id claims B's source while the restored bytes are A's: a re-keyed archive.
    records[0] = { ...records[0], sourceSha256: sha256(b) };
  }
  if (truncated) {
    // A's id returns A's body minus its tail: the sentinel byte is missing.
    const cut = a.subarray(0, a.length - 1);
    records[0] = { ...record(ID_A, 'rig_a', cut) };
  }
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
  return {
    requests: [
      { kind: 'main', n: 1, body: { messages } },
      { kind: 'main', n: 3, body: { messages } },
    ],
    sessionEvents: [
      resultEvent(20, 'rig_small', small), resultEvent(21, 'rig_a', a),
      resultEvent(22, 'rig_b', b), resultEvent(23, 'rig_c', keep),
      resultEvent(30, 'rig_a', Buffer.from(turnA, 'utf8'),
        { op: 'replace', startSeq: 21, endSeq: 21 }),
      resultEvent(31, 'rig_b', Buffer.from(turnB, 'utf8'),
        { op: 'replace', startSeq: 22, endSeq: 22 }),
    ],
    originResults: [
      resultEvent(20, 'rig_small', small), resultEvent(21, 'rig_a', a),
      resultEvent(22, 'rig_b', b), resultEvent(23, 'rig_c', keep),
    ],
    journal: [
      ask('rig_a', 'forgetall', 'an old numbered listing'),
      ask('rig_b', 'keeplines', 'kept the head of the listing'),
      ask('rig_c', 'keepall', null),
      applied('rig_a', 'forgetall', 28, 30),
      applied('rig_b', 'keeplines', 29, 31),
      applied('rig_c', 'keepall', 32, null),
    ],
    recallRecords: records,
    options: {},
  };
}

/**
 * The refusal leg's evidence (ISSUE-181 4a): the FIRST over-floor result
 * (`rig_a`) got an answer the reader refuses, so the journal carries
 * `entry-ask-refused` and the mount collapsed the ask/answer pair it had
 * appended. The two later asks answer normally. `sabotage` rewrites the set to
 * a shape a mount that IGNORED the refusal would leave:
 *
 *   'accepted'    the refusal row is gone; the bad answer read as a keepall
 *   'applied'     the refusal row stands, but the result was shaped anyway
 *   'uncollapsed' the refusal stands, but the ask/answer pair never left
 *
 * The positive control must be green, so each sabotage then fails by exactly
 * the named check that speaks for the fact it broke.
 */
function refusalEvidence({ sabotage = null } = {}) {
  const small = body('small', 2);
  const a = body('alpha', 24);   // rig_a: refused
  const b = body('beta', 24);    // rig_b: forgetall
  const c = body('gamma', 24);   // rig_c: keeplines
  const markerB = `[racoons] kept 0 of 24 lines · necromancy ${ID_B}\n`;
  const keptHead = c.subarray(0, c.indexOf(Buffer.from('gamma 5 ', 'utf8')));
  const markerC = `[racoons] kept lines 1–4 of 24 · ${String(c.length - keptHead.length)} bytes dropped · necromancy ${ID_C}\n`;
  const turnB = `an old numbered listing\n\n${markerB}`;
  const turnC = `kept the head of the listing\n\n${keptHead.toString('utf8')}${markerC}`;
  const askedAt = { seq: 24, type: 'user/message', surfaceOp: 'append',
    data: { content: [{ type: 'text', text: 'Memory management: decide which tool results below stay in your memory.' }] } };
  const answeredAt = { seq: 25, type: 'user/message', surfaceOp: 'append',
    data: { content: [{ type: 'text', text: '{"1":{"keephead":true}}' }] } };
  const collapsedAt = { seq: 26, type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 24, endSeq: 25 }, data: { content: [] } };
  const closing = { seq: 58, type: 'assistant/message', surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: 'All four commands ran.' }] } } };
  const journal = [];
  if (sabotage === 'accepted') {
    // The invalid answer was read as a keepall: an accepted ask and its rewind.
    journal.push(askLine('rig_a', 'keepall', null), applyLine('rig_a', 'keepall', 27, null));
  } else {
    journal.push({ kind: 'entry-ask-refused', eventId: 'dsh:synthetic:result:rig_a',
      callId: 'rig_a', code: 'action-not-in-grammar', retried: false, turns: 2,
      usage: { inputTokens: 10 } });
  }
  journal.push(
    askLine('rig_b', 'forgetall', 'an old numbered listing'),
    askLine('rig_c', 'keeplines', 'kept the head of the listing'),
    applyLine('rig_b', 'forgetall', 28, 30),
    applyLine('rig_c', 'keeplines', 29, 31),
  );
  if (sabotage === 'applied') {
    // The refusal was journalled, then a shaped turn landed over the result.
    journal.push(applyLine('rig_a', 'forgetall', 27, 32));
  }
  if (sabotage !== 'uncollapsed') {
    journal.push({ kind: 'entry-ask-collapsed', resultNodeId: 'dsh:synthetic:result:rig_a',
      askNodeId: 'dsh:synthetic:message:24', answerNodeId: 'dsh:synthetic:message:25',
      batchSize: 1, status: 'applied' });
  }
  const sessionEvents = [
    resultEvent(20, 'rig_small', small), resultEvent(21, 'rig_a', a),
    resultEvent(22, 'rig_b', b), resultEvent(23, 'rig_c', c),
    askedAt, answeredAt, collapsedAt,
    resultEvent(30, 'rig_b', Buffer.from(turnB, 'utf8'),
      { op: 'replace', startSeq: 22, endSeq: 22 }),
    resultEvent(31, 'rig_c', Buffer.from(turnC, 'utf8'),
      { op: 'replace', startSeq: 23, endSeq: 23 }),
  ];
  if (sabotage === 'applied') {
    sessionEvents.push(resultEvent(32, 'rig_a', Buffer.from(`kept all\n\n${markerB}`, 'utf8'),
      { op: 'replace', startSeq: 21, endSeq: 21 }));
  }
  sessionEvents.push(closing);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
  return {
    requests: [1, 3, 5, 7].map((n) => ({ kind: 'main', n, body: { messages } })),
    sessionEvents,
    originResults: [
      resultEvent(20, 'rig_small', small), resultEvent(21, 'rig_a', a),
      resultEvent(22, 'rig_b', b), resultEvent(23, 'rig_c', c),
    ],
    journal,
    recallRecords: [recallRecord(ID_B, 'rig_b', b), recallRecord(ID_C, 'rig_c', c)],
    options: { entryRefusal: true },
  };
}

// The refusal checks, by the names the runner prints.
const REFUSAL_CHECK = 'the invalid entry answer was refused by name';
const KEPT_CHECK = 'the refused result kept its bytes and id on the live surface';
const COLLAPSE_CHECK = 'the refused ask exchange was collapsed and the task ran to its last step';

test('the recall check binds each id to its own unit; a crossed id fails by name', () => {
  // Positive control: the synthetic evidence is coherent, so every check passes.
  const clean = assertEntryLane(syntheticEvidence());
  const cleanFailures = clean.results.filter((result) => !result.ok);
  assert.deepEqual(cleanFailures, [],
    `the fixture must start green: ${JSON.stringify(cleanFailures)}`);

  // A's id returns B's bytes, and B is landed: the old sha-only match passed.
  const crossed = assertEntryLane(syntheticEvidence({ crossed: 'bytes' }));
  const recall = crossed.results.find((result) => result.name === RECALL_CHECK);
  assert.ok(recall !== undefined, 'the recall check ran');
  assert.equal(recall.ok, false, `a crossed id must fail: ${JSON.stringify(recall)}`);
  assert.match(recall.detail, /rig_a/u, 'the failure names the unit whose id was crossed');
  assert.match(recall.detail, /archives source|restored/u,
    'the failure names the archive/restore mismatch');
});

test('the recall check refuses a re-keyed archive and a truncated body', () => {
  for (const [label, evidence] of [
    ['a source archived under the wrong id', syntheticEvidence({ crossed: 'source' })],
    ['a body missing its last sentinel byte', syntheticEvidence({ truncated: true })],
  ]) {
    const recall = assertEntryLane(evidence).results
      .find((result) => result.name === RECALL_CHECK);
    assert.ok(recall !== undefined, `${label}: the recall check ran`);
    assert.equal(recall.ok, false, `${label}: must fail, saw ${JSON.stringify(recall)}`);
  }
});

test('the identity check fails on a byte that is neither summary, marker, nor kept text', () => {
  const report = assertEntryLane(syntheticEvidence({ sabotage: 'framing' }));
  const identity = report.results
    .find((result) => result.name.startsWith('forget: the landed = kept'));
  assert.ok(identity !== undefined, 'the identity check ran');
  assert.equal(identity.ok, false, `framing must be measured, not assumed: ${JSON.stringify(identity)}`);
  assert.match(identity.detail, /framing is [1-9]\d*/u,
    'the failure names the leftover bytes');
});

// ── the ignored refusal, which only a broken mount can produce ────────────
// The real leg proves the product writes the refusal; these prove the checks
// REFUSE each way a refusal could be ignored. The positive control keeps the
// attribution honest: the fixture alone is green.

test('the refusal checks start green on the refusal evidence', () => {
  const clean = assertEntryLane(refusalEvidence());
  const cleanFailures = clean.results.filter((result) => !result.ok);
  assert.deepEqual(cleanFailures, [],
    `the refusal fixture must start green: ${JSON.stringify(cleanFailures)}`);
});

test('a refusal read as an accepted answer fails by name', () => {
  const report = assertEntryLane(refusalEvidence({ sabotage: 'accepted' }));
  const refusal = report.results.find((result) => result.name === REFUSAL_CHECK);
  assert.ok(refusal !== undefined, 'the refusal check ran');
  assert.equal(refusal.ok, false, `an accepted refusal must fail: ${JSON.stringify(refusal)}`);
  assert.match(refusal.detail, /entry-ask-refused/u,
    'the failure names the missing refusal row');
});

test('a refused result that was shaped anyway fails by name', () => {
  const report = assertEntryLane(refusalEvidence({ sabotage: 'applied' }));
  const kept = report.results.find((result) => result.name === KEPT_CHECK);
  assert.ok(kept !== undefined, 'the kept-surface check ran');
  assert.equal(kept.ok, false, `a shaped refused result must fail: ${JSON.stringify(kept)}`);
  assert.match(kept.detail, /apply line\(s\) named the refused result|replace\(s\) named the refused result node|changed bytes/u,
    'the failure names the write that touched the refused result');
});

test('a refusal whose ask exchange never collapsed fails by name', () => {
  const report = assertEntryLane(refusalEvidence({ sabotage: 'uncollapsed' }));
  const collapse = report.results.find((result) => result.name === COLLAPSE_CHECK);
  assert.ok(collapse !== undefined, 'the collapse check ran');
  assert.equal(collapse.ok, false, `a surviving ask pair must fail: ${JSON.stringify(collapse)}`);
  assert.match(collapse.detail, /entry-ask-collapsed|survived/u,
    'the failure names the uncollapsed exchange');
});

