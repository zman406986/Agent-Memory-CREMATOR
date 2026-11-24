#!/usr/bin/env node
/**
 * The 1d correctness corrections, as named tests (ISSUE-256 handoff).
 *
 * **Fix 1: the completion bill includes reasoning.** The host bills
 * `output + reasoning` at the output rate. `stepUsageFromStdout` therefore
 * returns their sum as `billedCompletionTokens`, keeps `outputTokens` and
 * `reasoningTokens` beside it, and the grant total is prompt + output +
 * reasoning. A step row with no reasoning field is unchanged.
 *
 * **Fix 2: the claim covers main-request bodies.** The bench-only ask/generate
 * requests re-send the conversation, including removed text, so the claim says
 * `main-request bodies`, discloses the ask requests by count, uses the ledger's
 * recall count as its denominator (`27 of 29 recall(s)`), and states the removed
 * result text's UTF-8 bytes beside the whole-unit ledger bytes. The one-line
 * summary counts failed assertions, the hard refusal and not-applicable checks
 * separately: a not-applicable check is never called a failure.
 *
 * Offline only: no host binary, no key, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  capturedSpend, removalClassLabel, removalReasonNote, runBench, runSummaryLine,
  spendReading, stepUsageFromStdout, withAskLane,
} from './opencode-run.mjs';

function stepFinish({ input = 0, output = 0, reasoning, cacheRead = 0, cacheWrite = 0 } = {}) {
  const tokens = {
    input,
    output,
    ...(reasoning === undefined ? {} : { reasoning }),
    cache: { read: cacheRead, write: cacheWrite },
  };
  return JSON.stringify({
    type: 'step_finish',
    part: { type: 'step-finish', tokens },
  });
}

function emptyStorageRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-claim-scope-'));
  mkdirSync(join(dir, 'storage', 'sessions'), { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------ fix 1: spend */

test('spend: a step with output 10 and reasoning 5 bills 15 completion and prompt + 15 total',
  () => {
    const host = stepUsageFromStdout(stepFinish({ input: 100, output: 10, reasoning: 5 }));
    assert.equal(host.steps, 1);
    assert.equal(host.billedPromptTokens, 100);
    assert.equal(host.outputTokens, 10);
    assert.equal(host.reasoningTokens, 5);
    assert.equal(host.billedCompletionTokens, 15,
      'the host bills output + reasoning at the output rate');

    const reading = spendReading({
      captured: capturedSpend([], null), host, grant: null,
    });
    assert.equal(reading.billedPromptTokens, 100);
    assert.equal(reading.billedCompletionTokens, 15);
    assert.equal(reading.billedTokens, 115);
    assert.equal(reading.hostCompletionTokens, 15);
    assert.equal(reading.hostOutputTokens, 10);
    assert.equal(reading.hostReasoningTokens, 5);
    assert.equal(reading.reasoningTokens, 5);

    const lanes = withAskLane(reading, [], null);
    assert.equal(lanes.totalPromptTokens, 100);
    assert.equal(lanes.totalCompletionTokens, 15);
    assert.equal(lanes.totalTokens, 115, 'the grant total is prompt + output + reasoning');

    const fired = withAskLane(spendReading({
      captured: capturedSpend([], null), host, grant: 114,
    }), [], 114);
    assert.equal(fired.fired, true, 'reasoning is counted in the grant comparison');
  });

test('spend: a step with no reasoning field is unchanged', () => {
  const host = stepUsageFromStdout(stepFinish({ input: 100, output: 10 }));
  assert.equal(host.reasoningTokens, 0);
  assert.equal(host.billedCompletionTokens, 10);
  assert.equal(host.outputTokens, 10);
  const reading = spendReading({
    captured: capturedSpend([], null), host, grant: null,
  });
  assert.equal(reading.billedCompletionTokens, 10);
  assert.equal(withAskLane(reading, [], null).totalTokens, 110);
});

test('spend: the 1d numbers become 112,748 completion and the host cost formula still matches',
  () => {
    const host = stepUsageFromStdout(stepFinish({
      input: 25_851_555, output: 72_585, reasoning: 40_163, cacheRead: 1_141_632,
    }));
    assert.equal(host.billedPromptTokens, 26_993_187);
    assert.equal(host.billedCompletionTokens, 112_748,
      '72,585 output + 40,163 reasoning');
    const reading = spendReading({
      captured: capturedSpend([], null), host, grant: null,
    });
    assert.equal(reading.billedTokens, 27_105_935);
    const cost = (25_851_555 * 0.150
      + 1_141_632 * 0.003
      + reading.billedCompletionTokens * 0.600) / 1_000_000;
    assert.equal(Number(cost.toFixed(9)), 3.948806946,
      'the host recorded USD 3.948806946; output + reasoning at 0.600/M reproduces it');
  });

/* ------------------------------------------------------------------ fix 2: claim scope */

/**
 * The 1d claim's world, as the class sentence reads it: 27 measured of the
 * ledger's 29 recalls, 2 not-applicable (re-exposed under a later result), the
 * 32 bench-only ask/generate requests, and the two byte figures.
 */
function claimWorld({ askRequests = 32 } = {}) {
  return {
    claimed: true,
    realRoute: true,
    mutateResult: false,
    measuredUnits: 27,
    candidateUnits: 27,
    ledgerRecallCount: 29,
    askRequests,
    notApplicableCount: 2,
    notApplicableUnits: 2,
    notApplicableReasons: { 're-exposed-under-later-result': 2 },
    removedResultTextBytes: 306_773,
    removedResultTextChars: 306_234,
    wholeUnitLedgerBytes: 352_630,
    removalMeasured: true,
  };
}

test('claim: a world with ask requests and 2 not-applicable units prints the main-request '
  + 'scope, the ask re-send disclosure, 27 of 29 and the removed-result byte figure', () => {
  const sentence = removalClassLabel(claimWorld());
  assert.match(sentence, /proven on the captured main-request bodies/u);
  assert.match(sentence, /absent from every main-request body after its first receipt/u);
  assert.match(sentence, /27 of 29 recall\(s\)/u,
    'the denominator is the ledger recall count, not 27 of 27 candidates');
  assert.match(sentence, /2 unit\(s\) are outside the claim \(re-exposed under a later result\)/u,
    'the 2 not-applicable units stay named');
  assert.match(sentence,
    /32 bench-only ask\/generate requests re-send the conversation including removed text and are outside this claim/u);
  assert.match(sentence, /306,773 UTF-8 bytes/u);
  assert.match(sentence, /306,234 UTF-16 code units/u,
    'the audit\'s 1d count is labelled as code units, never as the byte figure');
  assert.match(sentence, /whole-unit ledger bytes are 352,630 and are a separate figure/u);
  assert.match(sentence, /captured main-request-body check/u);

  const note = removalReasonNote({
    ...claimWorld(),
    captureAvailable: true,
    restoreNotExercised: true,
    absenceScope: 'decoded-string absence in the parsed main-request bodies',
  });
  assert.match(note, /proven on the captured main-request bodies/u);
  assert.match(note, /every later main request/u);
  assert.match(note, /32 bench-only ask\/generate requests re-send the conversation/u);
});

test('claim: a world without ask requests does not print the ask disclosure', () => {
  const sentence = removalClassLabel(claimWorld({ askRequests: 0 }));
  assert.doesNotMatch(sentence, /bench-only ask\/generate requests re-send/u);
  assert.doesNotMatch(sentence, /outside this claim \(they are not main-request bodies\)/u);
  assert.match(sentence, /27 of 29 recall\(s\)/u);
});

test('claim: a run with no ask requests records askRequestsCarryRemovedText false', () => {
  const dir = emptyStorageRoot();
  try {
    const task = { role: 'user', content: 'DONE' };
    const requests = [
      {
        seq: 1, kind: 'main', main_turn: 0, messages: [task], tools: [],
        body_bytes: 10, body_sha256: 'a', reasoning_messages: 0, reasoning_bytes: 0,
      },
    ];
    const result = runBench({
      requests, task: 'DONE', arm: 'test', storageRoot: dir, captureAvailable: true,
    });
    assert.equal(result.removal.askRequestsCarryRemovedText, false);
    assert.equal(result.removal.askRequestsOutsideClaim, 0);
    assert.equal(result.removal.claimBodies, 'main-request bodies');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claim: a run with an ask request discloses that it re-sends removed text', () => {
  const dir = emptyStorageRoot();
  try {
    const requests = [
      {
        seq: 1, kind: 'main', main_turn: 0,
        messages: [{ role: 'user', content: 'DONE' }], tools: [],
        body_bytes: 10, body_sha256: 'a', reasoning_messages: 0, reasoning_bytes: 0,
      },
      {
        seq: 2, kind: 'generate',
        messages: [{ role: 'user', content: 'the bench-only ask prompt' }], tools: [],
        body_bytes: 10, body_sha256: 'b',
      },
    ];
    const result = runBench({
      requests, task: 'DONE', arm: 'test', storageRoot: dir, captureAvailable: true,
      askGrammar: 'jsonl-20-nokeepall',
    });
    assert.equal(result.removal.askRequestsCarryRemovedText, true);
    assert.equal(result.removal.askRequestsOutsideClaim, 1);
    assert.equal(result.removal.claimBodies, 'main-request bodies');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ fix 2: summary */

test('summary: 3 failed assertions, 1 hard refusal and 3 not-applicable is not "6 failed"',
  () => {
    const assertions = [
      { name: 'a', status: 'fail' },
      { name: 'b', status: 'fail' },
      { name: 'c', status: 'fail' },
      { name: 'd', status: 'not-applicable' },
      { name: 'e', status: 'not-applicable' },
      { name: 'f', status: 'not-applicable' },
      { name: 'g', status: 'pass' },
    ];
    const summary = runSummaryLine({
      assertions, refusal: { code: 'redirect-real-data-changed' },
    });
    assert.equal(summary, '3 failed assertions + 1 hard refusal; 3 not-applicable');
    assert.doesNotMatch(summary, /6 failed/u);
    assert.equal(runSummaryLine({ assertions }), '3 failed assertions; 3 not-applicable');
    assert.equal(runSummaryLine({ assertions: [] }), '0 failed assertions; 0 not-applicable');
  });
