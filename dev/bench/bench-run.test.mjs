#!/usr/bin/env node
/**
 * The launcher's measurement gates, one test per audit finding: the twelfth
 * audit's items (ISSUE-214's dsh counterpart) and the thirteenth audit's ten
 * (reasoning sources, wire reasoning, the empty recall set, the Step 1b pruner
 * flag, a short context series, stop-on-compaction classes, vacuity classes,
 * the PASS line, the billed-prompt sum and the wire wording). The checks are
 * pure functions exported from `bench-run.mjs`: the file still runs `main()`
 * when executed, but importing it (the guard at the bottom compares
 * `process.argv[1]` to `import.meta.url`) assembles nothing and spawns nothing.
 *
 * What is held here:
 *
 *   1. reasoning counts and the ADR-0045 gate: zero reasoning refuses, a
 *      coverage below the declared floor refuses, and `--allow-zero-reasoning`
 *      records `none (no reasoning measured)`; the citable label needs content
 *      parts, stream blocks AND a measured request body;
 *   2. the wire-level reading: a captured body with `reasoning_content` is
 *      `measured` with its hash, a body without it is `absent` (red), and no
 *      body at all is `unmeasured` (not a pass);
 *   3. `context` and `compaction` are recorded for a non-replay provider, from
 *      the session log, with two `compaction/start` rows in the fixture;
 *   4. one malformed session line and one malformed request-log line fail by
 *      line number;
 *   5. a missing usage row breaks the reconciliation, and a `--token-grant`
 *      run fails closed on it;
 *   6. no grant registers no `the token grant did not fire` check;
 *   7. the cap pair is recorded as inert historical keys, never as a mechanism;
 *   8. a compaction-cut replay reports the consumed prefix, not "every reply";
 *   9. the runbook's Step 1b vanilla command takes the pruner opt-out;
 *   10. the reference prose matches ADR-0041 and the new result keys;
 *   11. the session and request logs are read once and hashed from those bytes;
 *   12. an applied removal with no published recall fails, and zero removals is
 *       not-applicable;
 *   13. the context series is judged against the session log's assistant turns;
 *   14. a stop-on-compaction 1-start/0-end pairing is `stopped-expected`;
 *   15. every assertion carries `class`/`contributesToPassed`, and the four
 *       known vacuous rows are marked;
 *   16. the PASS line states `citableAs`;
 *   17. billed prompt tokens are input + cacheRead + cacheWrite everywhere;
 *   18. preflight fails when the composed config does not match the ARM's
 *       `tool-result-pruner` state: disabled for racoons, host-default for
 *       vanilla (fifteenth audit item 3; arm rule 2026-11-09);
 *   19. a vanilla arm at zero table asks is `vacuous`, the same empty
 *       population as the racoons arm (fifteenth audit item 4);
 *   20. the compaction agreement's words match its `slice(first - 1)` and the
 *       host-pruner/billing check names match what they read (fifteenth audit
 *       item 6);
 *   21. ADR-0050's shape reaches the mount: the absolute prune bar and the off
 *       entry-ask trigger are carried by the config and named in the facts;
 *   22. the expected deliverable list comes from the brief (or
 *       `--deliverables`): the thirteen-name default still works, a 3-name list
 *       drives the rows, k order and the `task: the run wrote all N …` gate,
 *       and a missing file is red.
 *
 * Offline only: no dsh process, no provider, no key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  DEFAULTS,
  REASONING_TURN_COVERAGE_FLOOR,
  REPO_ROOT,
  REASONING_WIRE_FIELD,
  SCRATCHPAD,
  allowReadRefusal,
  armKillBox,
  askLaneCompleteness,
  assertionRow,
  assertionSummaryOf,
  benchDoneRequirement,
  blobPathFor,
  bodyReasoningText,
  budgetStopNote,
  checkpointPathValue,
  checkpointPrerequisiteFiles,
  checkpointsBlock,
  childEnvBase,
  contiguousPrefixK,
  duplicateDeliverables,
  evidenceDirRefusal,
  manifestDeliverablesGate,
  taskKeyRefusal,
  compactionAgreementGate,
  compactionClosedGate,
  compactionEvents,
  consumedPrefixOf,
  contextSeriesCoverage,
  createPolicyWatchdog,
  deliverableGate,
  deliverableRowsFor,
  hostCompactionLaneOutcome,
  hostPrunerRecord,
  hostPrunerState,
  isMeasurementProvider,
  jsonLineGate,
  journalState,
  killMsValue,
  ledgerState,
  measurementSummary,
  mountConfig,
  mountConfigFacts,
  passLineFor,
  patchRowTally,
  preflightPrunerRequirement,
  preflightWebRequirement,
  readBoundaryGate,
  readJsonLinesSnapshot,
  readWorldRoots,
  reasoningCountsOf,
  reasoningGate,
  reasoningWireGate,
  reasoningWireOf,
  recallLedgerGate,
  resolveBenchDeliverables,
  runCitableAs,
  stopAfterCompactionsValue,
  tableAskOutcome,
  tokenGrantGates,
  toolFailureOutcome,
  usageCoverageOf,
  vanillaEvidenceGate,
  vanillaPluginEntryRefusal,
  workspaceOnlyReport,
  workspaceTempSetup,
  writePatch,
} from './bench-run.mjs';
import { campaignRootFor, classifyToolCalls, inside } from './read-boundary.mjs';
import { capArchiveGate, removalCitable, removalLedgerGate, removalSummary,
  replacementAccounting } from './journal-fidelity.mjs';
import { armTreeGate, paidRouteManifestGate } from './manifest-gate.mjs';
import { loopbackGate } from './loopback-gate.mjs';
import { PROMPT_TOKEN_FIELDS, usageGap, usageRow, usageShape } from './session-usage.mjs';
import { SessionUsageWatch, createTokenWatchdog } from './token-watchdog.mjs';

const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url));
const hex = (text) => createHash('sha256').update(text).digest('hex');

/** A temp root under the repo's scratchpad: a launched evidence dir must resolve there. */
function scratchRoot(prefix) {
  mkdirSync(SCRATCHPAD, { recursive: true });
  return mkdtempSync(join(SCRATCHPAD, prefix));
}

/** One `assistant/message` row; `reasoning` entries become content parts. */
function assistantRow({ seq, reasoning = [], stream = [], usage = true }) {
  return {
    type: 'assistant/message',
    seq,
    data: {
      turn: 1,
      step: seq,
      ...(usage ? { usage: { inputTokens: 10, outputTokens: 2 } } : {}),
      message: {
        role: 'assistant',
        content: [
          ...reasoning.map((text) => ({ type: 'reasoning', text })),
          { type: 'text', text: `step ${seq}` },
        ],
      },
      // A string is the flat shape (`{ blockType }`); an object is passed
      // through so a test can state the official route's nested chunk entry.
      stream: stream.map((entry) => (typeof entry === 'string' ? { blockType: entry } : entry)),
    },
  };
}

test('item 1: reasoning counts carry the five result.json fields', () => {
  const counts = reasoningCountsOf([
    assistantRow({ seq: 1, reasoning: ['why one'], stream: ['reasoning'] }),
    assistantRow({ seq: 2, reasoning: [], stream: [] }),
  ]);
  assert.deepEqual(Object.keys(counts).sort(), [
    'assistantTurns', 'reasoningParts', 'reasoningStreamBlocks', 'reasoningTurns', 'turnCoverage',
  ].sort());
  assert.equal(counts.reasoningParts, 1);
  assert.equal(counts.reasoningTurns, 1);
  assert.equal(counts.assistantTurns, 2);
  assert.equal(counts.reasoningStreamBlocks, 1);
  assert.equal(counts.turnCoverage, 0.5);
});

test('item 1: a session with zero reasoning is refused and is not citable', () => {
  const counts = reasoningCountsOf([
    assistantRow({ seq: 1 }), assistantRow({ seq: 2 }), assistantRow({ seq: 3 }),
  ]);
  const gate = reasoningGate({ provider: 'deepseek-official', counts, allowZeroReasoning: false });
  assert.equal(gate.ok, false);
  assert.equal(gate.voided, false);
  assert.equal(gate.citableAs, 'none (no reasoning measured)');
  assert.match(gate.detail, /0 of 3/u);
  assert.match(gate.detail, /ADR-0045/u);
});

test('item 1: the explicit void flag records none (no reasoning measured)', () => {
  const counts = reasoningCountsOf([assistantRow({ seq: 1 }), assistantRow({ seq: 2 })]);
  const gate = reasoningGate({ provider: 'deepseek-official', counts, allowZeroReasoning: true });
  assert.equal(gate.ok, true);
  assert.equal(gate.voided, true);
  assert.equal(gate.citableAs, 'none (no reasoning measured)');
  assert.equal(gate.floor, REASONING_TURN_COVERAGE_FLOOR);
});

test('item 1: reasoning coverage below the declared floor is refused', () => {
  // 5 reasoning turns out of 10 assistant turns = 0.5, under the 0.55 floor.
  const rows = Array.from({ length: 10 }, (_, index) => assistantRow({
    seq: index + 1,
    reasoning: index < 5 ? [`why ${String(index)}`] : [],
  }));
  const counts = reasoningCountsOf(rows);
  const gate = reasoningGate({ provider: 'deepseek-official', counts, allowZeroReasoning: false });
  assert.equal(gate.turnCoverage, 0.5);
  assert.equal(gate.ok, false);
  assert.equal(gate.citableAs, 'none (no reasoning measured)');
  assert.match(gate.detail, /0\.5/u);
  assert.match(gate.detail, new RegExp(String(REASONING_TURN_COVERAGE_FLOOR), 'u'));
});

test('audit 13 item 1: a session at the floor with parts, stream blocks and a measured wire request is citable', () => {
  // 6 of 10 = 0.6, above the 0.55 floor. Every reasoning turn also carries a
  // stream block, and the captured wire carries the field in one main request:
  // all three sources the thirteenth audit requires.
  const rows = Array.from({ length: 10 }, (_, index) => assistantRow({
    seq: index + 1,
    reasoning: index < 6 ? [`why ${String(index)}`] : [],
    stream: index < 6 ? ['reasoning'] : [],
  }));
  const gate = reasoningGate({
    provider: 'deepseek-official',
    counts: reasoningCountsOf(rows),
    allowZeroReasoning: false,
    wire: { status: 'measured', requestsWithReasoning: 3 },
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.voided, false);
  assert.equal(gate.citableAs, 'measurement (reasoning measured)');
  assert.match(gate.detail, /wire carried reasoning_content/u);
});

test('audit 13 item 1: a session with content parts but no stream entries is not citable', () => {
  // The twelfth-audit fixture exactly: 10 assistant rows, 6 reasoning parts,
  // zero stream entries. It was citable before this fix; one structural source
  // is a partial transcript.
  const rows = Array.from({ length: 10 }, (_, index) => assistantRow({
    seq: index + 1,
    reasoning: index < 6 ? [`why ${String(index)}`] : [],
    stream: [],
  }));
  const gate = reasoningGate({
    provider: 'deepseek-official',
    counts: reasoningCountsOf(rows),
    allowZeroReasoning: false,
    wire: { status: 'measured', requestsWithReasoning: 3 },
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.citableAs, 'none (reasoning transcript incomplete)');
  assert.match(gate.detail, /stream blocks/u);
  assert.match(gate.detail, /ADR-0045/u);
});

test('audit 13 item 1: parts and streams with no measured wire request cannot claim reasoning measured', () => {
  const rows = Array.from({ length: 10 }, (_, index) => assistantRow({
    seq: index + 1,
    reasoning: index < 6 ? [`why ${String(index)}`] : [],
    stream: index < 6 ? ['reasoning'] : [],
  }));
  const gate = reasoningGate({
    provider: 'deepseek-official',
    counts: reasoningCountsOf(rows),
    allowZeroReasoning: false,
    wire: { status: 'unmeasured', requestsWithReasoning: 0 },
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.citableAs, 'measurement (product effect only; reasoning wire unmeasured)');
  assert.doesNotMatch(gate.citableAs, /reasoning measured/u);
});

test('audit 13 item 1: captured bodies with no reasoning_content are not citable as reasoning measured', () => {
  const rows = Array.from({ length: 10 }, (_, index) => assistantRow({
    seq: index + 1,
    reasoning: index < 6 ? [`why ${String(index)}`] : [],
    stream: index < 6 ? ['reasoning'] : [],
  }));
  const gate = reasoningGate({
    provider: 'deepseek-official',
    counts: reasoningCountsOf(rows),
    allowZeroReasoning: false,
    wire: { status: 'absent', requestsWithReasoning: 0 },
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.citableAs, 'none (no reasoning on the wire)');
});

test('audit 14 item 1: mock replay is not a measurement and cannot claim reasoning', () => {
  // The regression: the wire gate ran on mock-replay, where a scripted reply
  // never emits reasoning_content, so every Step 1b/1c run failed and the
  // projection was never written.
  assert.equal(isMeasurementProvider('mock-replay'), false);
  assert.equal(isMeasurementProvider('mock'), false);
  assert.equal(isMeasurementProvider('deepseek-official'), true);
  const counts = reasoningCountsOf([assistantRow({ seq: 1 }), assistantRow({ seq: 2 })]);
  const gate = reasoningGate({ provider: 'mock-replay', counts, allowZeroReasoning: false });
  assert.equal(gate.applicable, false);
  assert.equal(gate.ok, true);
  assert.equal(gate.voided, false);
  assert.equal(gate.citableAs, 'none (mock replay)');
  const wire = reasoningWireGate({
    provider: 'mock-replay',
    wire: { status: 'absent', requests: 41, bodies: 41, requestsWithReasoning: 0 },
  });
  assert.equal(wire.applicable, false);
  assert.equal(wire.ok, true);
  assert.equal(wire.class, 'not-applicable');
  assert.equal(wire.status, 'not-applicable');
  assert.match(wire.detail, /mock replay emits no reasoning/u);
});

test('official route: a block-start nested under chunk.blockType counts one stream block', () => {
  // The exact shape the 2026-11-07 smoke's session log writes
  // (scratchpad/launch/2026-11-07-dsh-live/effort-1024/…/session.v4.jsonl):
  //   {"type":"chunk","time":…,"chunk":{"type":"block-start","index":0,
  //    "blockType":"reasoning"}}
  // Before the fix the counter read only `entry.blockType`, so one content part
  // and one block-start read as 1 part and 0 blocks and the gate refused.
  const counts = reasoningCountsOf([assistantRow({
    seq: 1,
    reasoning: ['27*43 = 1161. 91*17 = 1547.'],
    stream: [
      { type: 'chunk', time: 1793996168606, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
      { type: 'reasoning-chunks', time0: 1793996168665, index: 0, texts: ['27', '*', '43'] },
      { type: 'chunk', time: 1793996168629, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
    ],
  })]);
  assert.equal(counts.reasoningParts, 1);
  assert.equal(counts.reasoningStreamBlocks, 1);
  assert.equal(counts.reasoningTurns, 1);
  assert.equal(counts.turnCoverage, 1);
  const gate = reasoningGate({
    provider: 'deepseek-official',
    counts,
    wire: { status: 'measured', requestsWithReasoning: 1 },
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.citableAs, 'measurement (reasoning measured)');
});

test('official route: the flat blockType shape still counts', () => {
  const counts = reasoningCountsOf([assistantRow({
    seq: 1, reasoning: ['why'], stream: ['reasoning'],
  })]);
  assert.equal(counts.reasoningParts, 1);
  assert.equal(counts.reasoningStreamBlocks, 1);
  assert.equal(reasoningGate({ provider: 'deepseek-official', counts }).ok, true);
});

test('official route: a reasoning part with no stream block still fails the gate', () => {
  const counts = reasoningCountsOf([assistantRow({ seq: 1, reasoning: ['why'], stream: [] })]);
  assert.equal(counts.reasoningParts, 1);
  assert.equal(counts.reasoningStreamBlocks, 0);
  const gate = reasoningGate({
    provider: 'deepseek-official',
    counts,
    wire: { status: 'measured', requestsWithReasoning: 1 },
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.citableAs, 'none (reasoning transcript incomplete)');
  assert.match(gate.detail, /stream blocks/u);
});

test('official route: a block-end and the replay state do not count as more blocks', () => {
  // The same log carries the finished block under `chunk.block` on a block-end
  // entry and the block again in the finish entry's `chunk.replayState.blocks`.
  // Counting either would report 3 blocks for one reasoning block.
  const counts = reasoningCountsOf([assistantRow({
    seq: 1,
    reasoning: ['why'],
    stream: [
      { type: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
      { type: 'chunk', chunk: { type: 'block-delta', index: 0, blockType: 'reasoning' } },
      { type: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'why' } } },
      {
        type: 'chunk',
        chunk: {
          type: 'finish',
          reason: { kind: 'stop' },
          replayState: { blocks: [{ type: 'reasoning' }, { type: 'text' }] },
        },
      },
    ],
  })]);
  assert.equal(counts.reasoningStreamBlocks, 1);
});

test('official route: a reasoning part is counted from either content nesting', () => {
  const underMessage = assistantRow({ seq: 1, reasoning: ['data.message.content'] });
  const underData = {
    type: 'assistant/message',
    seq: 2,
    data: { content: [{ type: 'reasoning', text: 'data.content' }, { type: 'text', text: 'ok' }] },
  };
  const counts = reasoningCountsOf([underMessage, underData]);
  assert.equal(counts.reasoningParts, 2);
  assert.equal(counts.reasoningTurns, 2);
  assert.equal(counts.assistantTurns, 2);
});

test('audit 13 item 2: reasoningWireOf records the field and the hash of the first main request body', () => {
  const thought = 'weigh the two readings before answering';
  const wire = reasoningWireOf([
    { n: 1, kind: 'title', body: { messages: [{ role: 'assistant', [REASONING_WIRE_FIELD]: 'title thought' }] } },
    { n: 2, kind: 'main', body: { messages: [{ role: 'user', content: 'go' }] } },
    { n: 3, kind: 'main', body: { messages: [
      { role: 'assistant', [REASONING_WIRE_FIELD]: thought },
      { role: 'user', content: 'next' },
    ] } },
  ]);
  assert.equal(wire.status, 'measured');
  assert.equal(wire.requests, 2);
  assert.equal(wire.bodies, 2);
  assert.equal(wire.requestsWithReasoning, 1);
  assert.equal(wire.request, 3);
  assert.equal(wire.field, REASONING_WIRE_FIELD);
  assert.equal(wire.sha256, hex(thought));
  assert.equal(bodyReasoningText({ messages: [{ role: 'assistant', [REASONING_WIRE_FIELD]: thought }] }), thought);
});

test('audit 13 item 2: reasoningWireOf records absent when bodies carry no reasoning and unmeasured when none was captured', () => {
  const absent = reasoningWireOf([
    { n: 1, kind: 'main', body: { messages: [{ role: 'assistant', content: 'no thought' }] } },
  ]);
  assert.equal(absent.status, 'absent');
  assert.equal(absent.requestsWithReasoning, 0);
  const unmeasured = reasoningWireOf([{ n: 1, kind: 'main' }]);
  assert.equal(unmeasured.status, 'unmeasured');
  assert.equal(unmeasured.bodies, 0);
});

test('audit 13 item 2: the wire gate fails captured bodies without reasoning and never passes unmeasured', () => {
  const absent = reasoningWireGate({
    provider: 'deepseek-official',
    wire: { status: 'absent', requests: 3, bodies: 3, requestsWithReasoning: 0 },
  });
  assert.equal(absent.ok, false);
  assert.equal(absent.class, 'failed');
  assert.match(absent.detail, /none carries reasoning_content/u);
  const unmeasured = reasoningWireGate({ provider: 'deepseek-official', wire: reasoningWireOf([]) });
  assert.equal(unmeasured.ok, true);
  assert.equal(unmeasured.class, 'not-applicable');
  assert.equal(unmeasured.status, 'unmeasured');
  assert.match(unmeasured.detail, /session log alone/u);
});

test('item 2: two compaction rows are recorded on a non-replay measurement', () => {
  const sessionEvents = [
    { type: 'step/start', seq: 1 },
    { type: 'step/start', seq: 2 },
    { type: 'compaction/start', seq: 5 },
    { type: 'compaction/end', seq: 6 },
    { type: 'step/start', seq: 7 },
    { type: 'compaction/start', seq: 9 },
    { type: 'compaction/end', seq: 10 },
  ];
  const usageRows = [
    { seq: 3, billedTokens: 100, inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
      outputTokens: 5, totalTokens: 105 },
    { seq: 8, billedTokens: 200, inputTokens: 180, cacheReadTokens: 20, cacheWriteTokens: 0,
      outputTokens: 7, totalTokens: 207 },
  ];
  const summary = measurementSummary({ sessionEvents, requests: [], usageRows });
  assert.equal(summary.compaction.count, 2);
  assert.equal(summary.compaction.ends, 2);
  assert.deepEqual(summary.compaction.atRequests, [3, 4]);
  assert.equal(summary.compaction.compacted, true);
  assert.notEqual(summary.context, null);
  assert.equal(summary.context.unit, 'billed-prompt-tokens');
  assert.deepEqual(summary.context.series, [100, 200]);
  assert.equal(summary.context.peak, 200);
});

test('item 2: the byte series still serves a run whose request log exists', () => {
  const summary = measurementSummary({
    sessionEvents: [],
    requests: [{ kind: 'main', body_bytes: 1000 }, { kind: 'title', body_bytes: 50 },
      { kind: 'main', body_bytes: 2000 }],
    usageRows: [],
  });
  assert.equal(summary.context.unit, 'bytes');
  assert.deepEqual(summary.context.series, [1000, 2000]);
  assert.equal(summary.compaction.count, 0);
  assert.notEqual(summary.compaction, null);
});

test('item 3: one malformed session line is named by line number', () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-bench-lines-'));
  // The interpreter is run from the bench dir, never this fixture dir; the file
  // is only data.
  const file = join(dir, 'session.v4.jsonl');
  writeFileSync(file, `${JSON.stringify({ type: 'step/start', seq: 1 })}\nthis is not json\n`);
  const snapshot = readJsonLinesSnapshot(file);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(snapshot.events.length, 2);
  assert.deepEqual(snapshot.malformed.map((row) => row.line), [2]);
  const gate = jsonLineGate([snapshot], 'session log');
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /session log/u);
  assert.match(gate.detail, /:2/u);
});

test('item 3: one malformed request-log line is named by line number', () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-bench-lines-'));
  const file = join(dir, 'requests.jsonl');
  writeFileSync(file, `{"kind":"main"}\n{"kind":"main", oops}\n`);
  const snapshot = readJsonLinesSnapshot(file);
  rmSync(dir, { recursive: true, force: true });
  const gate = jsonLineGate([snapshot], 'request log');
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /request log/u);
  assert.match(gate.detail, /:2/u);
});

test('item 3: every line parsing is green', () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-bench-lines-'));
  const file = join(dir, 'requests.jsonl');
  writeFileSync(file, `{"kind":"main"}\n{"kind":"title"}\n`);
  const snapshot = readJsonLinesSnapshot(file);
  rmSync(dir, { recursive: true, force: true });
  const gate = jsonLineGate([snapshot], 'request log');
  assert.equal(gate.ok, true);
  assert.equal(gate.count, 0);
});

test('item 4: a missing usage row breaks the coverage reconciliation', () => {
  const events = [
    assistantRow({ seq: 1, usage: true }),
    assistantRow({ seq: 2, usage: false }),
  ];
  const coverage = usageCoverageOf(events);
  assert.equal(coverage.assistantTurns, 2);
  assert.equal(coverage.usageRows, 1);
  assert.equal(coverage.missingRows, 1);
  assert.equal(coverage.reconciled, false);
  assert.deepEqual(coverage.missingSeqs, [2]);
});

test('item 4: the token-grant gate fails closed when a usage row is missing', () => {
  const coverage = usageCoverageOf([
    assistantRow({ seq: 1, usage: true }), assistantRow({ seq: 2, usage: false }),
  ]);
  const gates = tokenGrantGates({
    tokenGrant: 1_000,
    // A readable, non-zero reading so the missing-row reason is the one stated;
    // the zero-reading fail-closed case has its own test (fifteenth audit).
    tokenWatch: { tokenFired: false, observedPromptTokens: 500, polls: 1, error: null },
    usageCoverage: coverage,
  });
  assert.equal(gates.length, 3);
  const measured = gates.find((gate) => gate.name === 'the token grant measured every step');
  assert.notEqual(measured, undefined);
  assert.equal(measured.ok, false);
  assert.match(measured.detail, /no usage row/u);
});

test('ISSUE-237: a compaction/start with no summary fails the grant gate closed', () => {
  const coverage = usageCoverageOf([assistantRow({ seq: 1, usage: true })]);
  const gates = tokenGrantGates({
    tokenGrant: 1_000,
    // Every assistant turn carries its row; the missing spend is the native
    // compaction call, so the compaction check is the reason the gate fails.
    tokenWatch: { tokenFired: false, observedPromptTokens: 500, polls: 2, error: null,
      compactionUsageRows: 0, compactionUsageComplete: false },
    usageCoverage: coverage,
  });
  const measured = gates.find((gate) => gate.name === 'the token grant measured every step');
  assert.notEqual(measured, undefined);
  assert.equal(measured.ok, false);
  assert.match(measured.detail, /compaction\/summary/u);
  assert.match(measured.detail, /lower bound/u);

  // The same log with its summary read is complete, so the gate passes.
  const complete = tokenGrantGates({
    tokenGrant: 1_000,
    tokenWatch: { tokenFired: false, observedPromptTokens: 500, polls: 2, error: null,
      compactionUsageRows: 1, compactionUsageComplete: true },
    usageCoverage: coverage,
  }).find((gate) => gate.name === 'the token grant measured every step');
  assert.equal(complete.ok, true);
});

test('fifteenth audit item 3: a grant whose reading was 0 with turns in the log fails closed', () => {
  const coverage = usageCoverageOf([assistantRow({ seq: 1 }), assistantRow({ seq: 2 })]);
  const gates = tokenGrantGates({
    tokenGrant: 1_000,
    tokenWatch: { tokenFired: false, observedPromptTokens: 0, polls: 3, error: null },
    usageCoverage: coverage,
  });
  const measured = gates.find((gate) => gate.name === 'the token grant measured every step');
  assert.equal(measured.ok, false);
  assert.match(measured.detail, /read 0 billed prompt tokens/u);
  assert.equal(gates.find((gate) => gate.name === 'the token grant was readable').ok, true);
});

test('fifteenth audit item 3: an unreadable poll fails the readable-grant row by name', () => {
  const gates = tokenGrantGates({
    tokenGrant: 1_000,
    tokenWatch: { tokenFired: false, observedPromptTokens: 0, polls: 0, error: 'EIO: disk went away' },
    usageCoverage: { assistantTurns: 0, usageRows: 0, missingRows: 0, missingSeqs: [], reconciled: true },
  });
  const readable = gates.find((gate) => gate.name === 'the token grant was readable');
  assert.equal(readable.ok, false);
  assert.match(readable.detail, /EIO/u);
});

test('item 5: no grant registers no token-grant check', () => {
  assert.deepEqual(tokenGrantGates({
    tokenGrant: null, tokenWatch: { tokenFired: false }, usageCoverage: { reconciled: true },
  }), []);
});

test('item 5: a grant registers the did-not-fire check', () => {
  const gates = tokenGrantGates({
    tokenGrant: 1_000,
    tokenWatch: { tokenFired: false, observedPromptTokens: 500, polls: 1, error: null },
    usageCoverage: { assistantTurns: 1, usageRows: 1, missingRows: 0, reconciled: true },
  });
  assert.equal(gates.length, 3);
  assert.equal(gates[0].name, 'the token grant did not fire');
  assert.equal(gates[0].ok, true);
  assert.equal(gates[1].name, 'the token grant was readable');
  assert.equal(gates[1].ok, true);
  assert.equal(gates[2].ok, true);
});

test('item 6: the cap pair is recorded as inert historical keys', () => {
  const facts = mountConfigFacts({
    capBytes: 8192, capHeadBytes: 8192, sealMaxLatencyTurns: 1,
  });
  assert.equal(facts.capIgnored, true);
  // Fourteenth audit item 6: the flag is a declaration, never presented as a
  // probe of the mounted build.
  assert.equal(facts.capIgnoredSource, 'declared');
  assert.deepEqual(facts.inertKeys, ['capBytes', 'capHeadBytes']);
  assert.deepEqual(facts.liveKeys, ['sealMaxLatencyTurns']);
  assert.equal(facts.inertValuesMatch, true);
  assert.equal(facts.sealBoundMatches, true);
});

test('patch: agent-default-model requests reasoning effort low on every real route', (t) => {
  // Without an effort pi-ai sends `thinking: {type: "disabled"}` on the
  // DeepSeek provider, so a live run records zero reasoning. The base rows are
  // shared by both arms; the row must carry `low` on every real route.
  for (const provider of ['deepseek-official', 'deepseek-v4-pro']) {
    const dir = mkdtempSync(join(tmpdir(), `racoons-patch-${provider}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = writePatch(dir, {
      arm: 'vanilla', provider, allowHostPruner: false, allowOfficialSpend: false, omitDenyRows: false,
    }, null, null);
    const text = readFileSync(path, 'utf8');
    assert.match(text, /- id: agent-default-model\n  config:\n    provider: [^\n]+\n    model: [^\n]+\n    reasoningEffort: low\n/u);
  }
});

test('ISSUE-291: --host-window-tokens lands on the composed llm-pi-ai model row', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-patch-host-window-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = writePatch(dir, {
    arm: 'vanilla', provider: 'deepseek-official', hostWindowTokens: 200000,
    allowHostPruner: false, allowOfficialSpend: false, omitDenyRows: false,
  }, null, null);
  const text = readFileSync(path, 'utf8');
  // The row the real route moves to must carry the flag's value, not the
  // hardcoded 400000: compaction-basic triggers at 170000 for this window.
  assert.match(text, /- id: llm-pi-ai\n[\s\S]*?contextWindow: 200000\n/u);
  assert.doesNotMatch(text, /contextWindow: 400000/u);
});

test('ISSUE-291: an omitted --host-window-tokens keeps the 400000 host window', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-patch-host-window-default-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = writePatch(dir, {
    arm: 'vanilla', provider: 'deepseek-official', hostWindowTokens: null,
    allowHostPruner: false, allowOfficialSpend: false, omitDenyRows: false,
  }, null, null);
  assert.equal(DEFAULTS.hostWindowTokens, 400000);
  assert.match(readFileSync(path, 'utf8'), /contextWindow: 400000\n/u);
});

test('ISSUE-297: --pwsh-guard lands on the composed pwsh executor for both arms', (t) => {
  for (const arm of ['racoons', 'vanilla']) {
    const dir = mkdtempSync(join(tmpdir(), `racoons-patch-pwsh-guard-${arm}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const guard = "C:\\Users\\TZhen\\racoons's build\\pwsh-guard.exe";
    const path = writePatch(dir, {
      arm, provider: 'deepseek-official', pwshGuard: guard,
      allowHostPruner: false, allowOfficialSpend: false, omitDenyRows: false,
    }, null, null);
    const text = readFileSync(path, 'utf8');
    // The row is what makes the wrapper the shell for every pwsh call; a
    // dropped row would silently restore the unconfined executor. The single
    // quote in the path doubles so the YAML scalar stays one string.
    assert.match(text, /- id: pwsh-sandbox\n  config:\n    pwshPath: '[^\n]*pwsh-guard\.exe'\n/u);
    assert.match(text, /racoons''s build/u);
  }
});

test('ISSUE-291: --host-window-tokens is refused on the mock lanes by name', () => {
  const result = spawnSync(process.execPath, [LAUNCHER, '--arm', 'vanilla',
    '--provider', 'mock', '--dry-work', '--host-window-tokens', '200000'],
  { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--host-window-tokens belongs to a real provider/u);
});

test('item 7: a compaction-cut replay reports the consumed prefix', () => {
  const prefix = consumedPrefixOf({
    wanted: ['a', 'b', 'c', 'd', 'e'],
    seen: ['a', 'b', 'c'],
    cutByCompaction: true,
  });
  assert.equal(prefix.ok, true);
  assert.equal(prefix.consumed, 3);
  assert.equal(prefix.scripted, 5);
  assert.equal(prefix.cutByCompaction, true);
  assert.match(prefix.detail, /consumed prefix 3 of 5/u);
  assert.match(prefix.detail, /cut by host compaction/u);
});

test('item 7: a full replay keeps the green detail and the N of N prefix', () => {
  const prefix = consumedPrefixOf({
    wanted: ['a', 'b', 'c'], seen: ['a', 'b', 'c'], cutByCompaction: false,
  });
  assert.equal(prefix.ok, true);
  assert.equal(prefix.consumed, 3);
  assert.equal(prefix.scripted, 3);
  assert.match(prefix.detail, /consumed prefix 3 of 3/u);
});

test('item 7: a skipped reply still fails by request number', () => {
  const prefix = consumedPrefixOf({
    wanted: ['a', 'b', 'c'], seen: ['a', 'c'], cutByCompaction: true,
  });
  assert.equal(prefix.ok, false);
  assert.match(prefix.detail, /request 2/u);
});

test('audit 13 item 4: Step 1b takes --allow-host-pruner on vanilla and never on racoons', () => {
  const text = readFileSync(join(BENCH_DIR, 'runbook.md'), 'utf8');
  // The prose and the command must agree (ADR-0041 Decision 1): the vanilla arm
  // models the host as shipped and replays a recording made with the pruner on.
  assert.match(text, /replays a recording made with it on/u);
  assert.doesNotMatch(text, /vanilla arm runs it on/u);
  assert.match(text, /runHostPruner: "none"/u);
  const step = text.slice(text.indexOf('## Step 1b'), text.indexOf('### Synthetic pressure'));
  const vanilla = step.slice(step.indexOf('--arm vanilla'), step.indexOf('--arm racoons'));
  const racoons = step.slice(step.indexOf('--arm racoons'), step.indexOf('```', step.indexOf('--arm racoons')));
  assert.match(vanilla, /--allow-host-pruner/u);
  assert.doesNotMatch(racoons, /--allow-host-pruner/u);
});

test('audit 13 item 9: the billed prompt is input + cacheRead + cacheWrite everywhere', () => {
  const launcher = readFileSync(join(BENCH_DIR, 'bench-run.mjs'), 'utf8');
  const reference = readFileSync(join(BENCH_DIR, 'reference.md'), 'utf8');
  for (const text of [launcher, reference]) {
    assert.doesNotMatch(text, /input \+ cacheRead, the derivation/u);
    assert.doesNotMatch(text, /\(input \+ cacheRead\)/u);
    assert.match(text, /input \+ cacheRead \+ cacheWrite/u);
  }
});

test('audit 13 item 10: the reference says what reasoningWire unmeasured means and makes no wire claim', () => {
  const text = readFileSync(join(BENCH_DIR, 'reference.md'), 'utf8');
  assert.match(text, /`reasoningWire`/u);
  assert.match(text, /"unmeasured"` means \*\*no request body was captured at all\*\*/u);
  assert.match(text, /not a wire claim/u);
  assert.match(text, /session log only/u);
  // The dsh bench reads request bodies on the mock lanes and the session log on
  // a real route; no sentence may call that network capture.
  assert.doesNotMatch(text, /reasoning (was )?captured (on|from) the wire/iu);
});

test('item 9: the reference says result.json carries context and compaction on every provider', () => {
  const text = readFileSync(join(BENCH_DIR, 'reference.md'), 'utf8');
  assert.match(text, /`context` and `compaction`[^.]*every provider/isu);
  assert.match(text, /`reasoning`/u);
  assert.match(text, /`citableAs`/u);
  assert.match(text, /`reasoningWire`/u);
});

test('item 6 docs: the reference no longer calls the cap pair a bench mechanism', () => {
  const text = readFileSync(join(BENCH_DIR, 'reference.md'), 'utf8');
  assert.doesNotMatch(text, /cap pair explicit/u);
  assert.match(text, /capIgnored/u);
});

test('audit 13 item 3: an applied removal with no published recall fails the recall gate', () => {
  const gate = recallLedgerGate({ recallIds: [], removals: 1, ledgerRecallIds: [] });
  assert.equal(gate.ok, false);
  assert.equal(gate.class, 'failed');
  assert.match(gate.detail, /1 removal\(s\) were applied/u);
  assert.match(gate.detail, /no recall id/u);
});

test('audit 13 item 3: zero removals records not-applicable and is not a pass', () => {
  const gate = recallLedgerGate({ recallIds: [], removals: 0, ledgerRecallIds: [] });
  assert.equal(gate.ok, true);
  assert.equal(gate.class, 'not-applicable');
  const row = assertionRow('recall', gate);
  assert.equal(row.contributesToPassed, false);
  assert.match(gate.detail, /not exercised/u);
});

test('audit 13 item 3: a published recall missing from the ledger is still red', () => {
  const gate = recallLedgerGate({ recallIds: ['r-1', 'r-2'], removals: 2, ledgerRecallIds: ['r-1'] });
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /r-2/u);
});

// ── The recall id's two journal sources ──────────────────────────────────────
//
// Live evidence: the racoons arm applied 57 removals and the ledger held all 57
// recall ids, but the journal's `entry-apply`/`prune-apply` rows carry no
// `recallId`, and entry/revert modes write no `publish` row. The ids are on the
// application telemetry. These tests pin both routes and the reverse check.

test('recall fidelity: applied-application telemetry supplies and dedupes the recall id', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'racoons-recall-telemetry-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const evidence = join(base, 'racoons');
  mkdirSync(evidence, { recursive: true });
  const text = 'an archived result that only the telemetry names';
  const sha = createHash('sha256').update(text).digest('hex');
  const id = `recall:sha256:${sha}`;
  const row = { kind: 'telemetry',
    event: { kind: 'application', outcome: 'applied', recallIds: [id, id] } };
  writeFileSync(join(evidence, 'cremator-events.jsonl'),
    `${JSON.stringify(row)}\n${JSON.stringify(row)}\n`);
  const state = journalState([evidence], null);
  assert.deepEqual(state.journal.recallIds, [id]);
  const blobRoot = join(base, 'blobs');
  mkdirSync(join(blobRoot, 'sha256', sha.slice(0, 2)), { recursive: true });
  writeFileSync(blobPathFor(blobRoot, sha), text);
  const gate = recallLedgerGate({
    recallIds: state.journal.recallIds, removals: 1, ledgerRecallIds: [id],
    recallParts: [{ recallId: id, partIndex: 0, sourceSha256: sha,
      sourceByteLength: Buffer.byteLength(text), blobSha256: sha }],
    blobRoot,
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.class, 'measured');
});

test('recall fidelity: a publish archive still supplies the recall id', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'racoons-recall-publish-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const evidence = join(base, 'racoons');
  mkdirSync(evidence, { recursive: true });
  const text = 'an archived result published the old way';
  const sha = createHash('sha256').update(text).digest('hex');
  const id = `recall:sha256:${sha}`;
  writeFileSync(join(evidence, 'cremator-events.jsonl'),
    `${JSON.stringify({ kind: 'publish', archives: [{ operationKind: 'evict', ruleId: 'r', recallId: id }] })}\n`);
  const state = journalState([evidence], null);
  assert.deepEqual(state.journal.recallIds, [id]);
  const blobRoot = join(base, 'blobs');
  mkdirSync(join(blobRoot, 'sha256', sha.slice(0, 2)), { recursive: true });
  writeFileSync(blobPathFor(blobRoot, sha), text);
  const gate = recallLedgerGate({
    recallIds: state.journal.recallIds, removals: 1, ledgerRecallIds: [id],
    recallParts: [{ recallId: id, partIndex: 0, sourceSha256: sha,
      sourceByteLength: Buffer.byteLength(text), blobSha256: sha }],
    blobRoot,
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.class, 'measured');
});

test('recall fidelity: a ledger recall id absent from both sources fails by name', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'racoons-recall-unbacked-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const evidence = join(base, 'racoons');
  mkdirSync(evidence, { recursive: true });
  const id = `recall:sha256:${'b'.repeat(64)}`;
  const stray = `recall:sha256:${'c'.repeat(64)}`;
  writeFileSync(join(evidence, 'cremator-events.jsonl'),
    `${JSON.stringify({ kind: 'telemetry',
      event: { kind: 'application', outcome: 'applied', recallIds: [id] } })}\n`);
  const state = journalState([evidence], null);
  const gate = recallLedgerGate({
    recallIds: state.journal.recallIds, removals: 1, ledgerRecallIds: [id, stray],
    recallParts: [{ recallId: id, partIndex: 0, sourceSha256: 'b'.repeat(64),
      sourceByteLength: 1, blobSha256: 'b'.repeat(64) }],
    blobRoot: join(base, 'blobs'),
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.class, 'failed');
  assert.match(gate.detail, new RegExp(stray, 'u'));
  assert.match(gate.detail, /absent from both/u);
});

// ── Fourteenth audit ─────────────────────────────────────────────────────────

test('audit 14 item 2: a renamed usage field is refused, not summed as 0', () => {
  const renamed = {
    type: 'assistant/message', seq: 1,
    data: { turn: 1, step: 1, usage: { promptTokens: 12_345, outputTokens: 5 } },
  };
  const shape = usageShape(renamed.data.usage);
  assert.equal(shape.present, true);
  assert.equal(shape.recognized, false);
  assert.deepEqual(shape.promptFields, []);
  assert.deepEqual(PROMPT_TOKEN_FIELDS, ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']);
  assert.equal(usageGap(renamed), 'unrecognized');
  assert.equal(usageRow(renamed), null);
  const coverage = usageCoverageOf([renamed]);
  assert.equal(coverage.assistantTurns, 1);
  assert.equal(coverage.usageRows, 0);
  assert.equal(coverage.reconciled, false);
  assert.equal(coverage.unrecognizedRows, 1);
  assert.deepEqual(coverage.unrecognizedSeqs, [1]);
  const gates = tokenGrantGates({
    tokenGrant: 1_000_000,
    tokenWatch: { tokenFired: false, usageUnrecognized: 1 },
    usageCoverage: coverage,
  });
  const measured = gates.find((gate) => gate.name === 'the token grant measured every step');
  assert.notEqual(measured, undefined);
  assert.equal(measured.ok, false);
  assert.match(measured.detail, /no recognizable prompt token field/u);
});

test('audit 14 item 2: a missing token field is refused, not summed as 0', () => {
  const missing = {
    type: 'assistant/message', seq: 2,
    data: { turn: 1, step: 2, usage: { totalTokens: 42, outputTokens: 7 } },
  };
  assert.equal(usageShape(missing.data.usage).recognized, false);
  assert.equal(usageGap(missing), 'unrecognized');
  assert.equal(usageRow(missing), null);
  const coverage = usageCoverageOf([missing]);
  assert.equal(coverage.reconciled, false);
  assert.equal(coverage.unrecognizedRows, 1);
  // A turn with no usage object is still the older absent class, named apart.
  const absent = { type: 'assistant/message', seq: 3, data: { turn: 1, step: 3 } };
  assert.equal(usageGap(absent), 'absent');
  assert.equal(usageCoverageOf([absent]).unrecognizedRows, 0);
});

test('audit 14 item 2: the watchdog refuses a renamed field instead of summing 0', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'racoons-usage-refusal-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sessions = join(base, 'sessions');
  const sessionDir = join(sessions, '--arm--', 'session-0001');
  mkdirSync(sessionDir, { recursive: true });
  const log = join(sessionDir, 'session.v4.jsonl');
  writeFileSync(log, `${JSON.stringify({
    type: 'assistant/message', seq: 1,
    data: { turn: 1, step: 1, usage: { promptTokens: 900, outputTokens: 4 } },
  })}\n`);
  const watch = new SessionUsageWatch(sessions);
  t.after(() => watch.close());
  const totals = watch.poll();
  assert.equal(totals.billedPromptTokens, 0);
  assert.equal(totals.rows, 0);
  assert.equal(totals.unrecognized, 1);
  const dog = createTokenWatchdog({ grant: 1_000, watch });
  const state = dog.pollOnce();
  assert.equal(state.tokenFired, false);
  assert.equal(state.usageUnrecognized, 1);
  assert.equal(state.refused, true);
  assert.match(String(state.error), /no recognizable prompt token field/u);
});

/** A temp blob root with one published blob; returns its sha256 and path. */
function blobFixture(t, bytes) {
  const base = mkdtempSync(join(tmpdir(), 'racoons-blobs-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const blobRoot = join(base, 'blobs');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const file = blobPathFor(blobRoot, sha);
  mkdirSync(join(blobRoot, 'sha256', sha.slice(0, 2)), { recursive: true });
  writeFileSync(file, bytes);
  return { blobRoot, sha, file };
}

/** One recall part row for a published blob. */
function partOf(recallId, sha, text) {
  return {
    recallId, partIndex: 0, sourceSha256: sha,
    sourceByteLength: Buffer.byteLength(text), blobSha256: sha,
  };
}

test('audit 14 item 4: a published recall whose blob hashes to source/blob sha256 passes', (t) => {
  const text = 'the archived tool result, byte for byte';
  const { blobRoot, sha } = blobFixture(t, text);
  const id = `recall:sha256:${hex('published-recall')}`;
  const gate = recallLedgerGate({
    recallIds: [id], removals: 1, ledgerRecallIds: [id],
    recallParts: [partOf(id, sha, text)], blobRoot,
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.class, 'measured');
  assert.equal(gate.blobsChecked, 1);
  assert.match(gate.detail, /hash to source_sha256\/blob_sha256/u);
});

test('audit 14 item 4: a published recall with a missing blob is red', (t) => {
  const text = 'bytes that were never published';
  const { blobRoot, sha, file } = blobFixture(t, text);
  rmSync(file);
  const id = `recall:sha256:${hex('missing')}`;
  const gate = recallLedgerGate({
    recallIds: [id], removals: 1, ledgerRecallIds: [id],
    recallParts: [partOf(id, sha, text)], blobRoot,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.class, 'failed');
  assert.match(gate.detail, /missing at/u);
});

test('audit 14 item 4: a published recall with an empty blob is red', (t) => {
  const text = 'bytes';
  const { blobRoot, sha, file } = blobFixture(t, text);
  writeFileSync(file, '');
  const id = `recall:sha256:${hex('empty')}`;
  const gate = recallLedgerGate({
    recallIds: [id], removals: 1, ledgerRecallIds: [id],
    recallParts: [partOf(id, sha, text)], blobRoot,
  });
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /is empty/u);
});

test('audit 14 item 4: a published recall whose blob does not hash to the ledger is red', (t) => {
  const text = 'the bytes the ledger names';
  const { blobRoot, sha, file } = blobFixture(t, text);
  writeFileSync(file, 'different bytes at the same path');
  const id = `recall:sha256:${hex('mismatch')}`;
  const gate = recallLedgerGate({
    recallIds: [id], removals: 1, ledgerRecallIds: [id],
    recallParts: [partOf(id, sha, text)], blobRoot,
  });
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /hashes to/u);
});

test('audit 14 item 4: a published recall with no recall_parts row is red', (t) => {
  const { blobRoot } = blobFixture(t, 'x');
  const id = `recall:sha256:${hex('no-parts')}`;
  const gate = recallLedgerGate({
    recallIds: [id], removals: 1, ledgerRecallIds: [id], recallParts: [], blobRoot,
  });
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /no recall_parts row/u);
});

test('audit 14 item 4: the ledger read carries recall_parts and the blob root the gate opens', (t) => {
  // End-to-end over a real sqlite file shaped like the shipped ledger, so the
  // gate cannot pass on ids alone: the parts and the sibling blobs/ directory
  // come from the same read.
  const base = mkdtempSync(join(tmpdir(), 'racoons-ledger-blobs-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sessionDir = join(base, 'storage', 'sessions', 'session-1');
  mkdirSync(sessionDir, { recursive: true });
  const ledgerPath = join(sessionDir, 'ledger.sqlite');
  const db = new DatabaseSync(ledgerPath);
  db.exec('CREATE TABLE ledger_events (kind TEXT);'
    + 'CREATE TABLE application_removals (operation_kind TEXT, episode_id TEXT);'
    + 'CREATE TABLE recalls (recall_id TEXT);'
    + 'CREATE TABLE recall_parts (recall_id TEXT, part_index INTEGER, source_sha256 TEXT,'
    + ' source_byte_length INTEGER, blob_sha256 TEXT);');
  const text = 'a real archived result';
  const sha = createHash('sha256').update(text).digest('hex');
  const id = `recall:sha256:${sha}`;
  db.prepare('INSERT INTO recalls VALUES (?)').run(id);
  db.prepare('INSERT INTO recall_parts VALUES (?, 0, ?, ?, ?)')
    .run(id, sha, Buffer.byteLength(text), sha);
  db.close();
  const file = blobPathFor(join(sessionDir, 'blobs'), sha);
  mkdirSync(join(sessionDir, 'blobs', 'sha256', sha.slice(0, 2)), { recursive: true });
  writeFileSync(file, text);
  const state = ledgerState(ledgerPath);
  assert.equal(state.present, true);
  assert.equal(state.readable, true);
  assert.deepEqual(state.recallIds, [id]);
  assert.equal(state.recallParts.length, 1);
  assert.equal(state.recallParts[0].sourceSha256, sha);
  assert.equal(state.recallParts[0].blobSha256, sha);
  assert.equal(state.blobRoot, join(sessionDir, 'blobs'));
  const gate = recallLedgerGate({
    recallIds: [id], removals: 1, ledgerRecallIds: state.recallIds,
    recallParts: state.recallParts, blobRoot: state.blobRoot,
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.class, 'measured');
  assert.equal(gate.blobsChecked, 1);
});

test('audit 14 item 5: capArchiveGate with no archives is not-applicable', () => {
  const none = capArchiveGate({ capArchives: 0, evictArchives: 0, verdictArchives: 0, archiveTotal: 0 });
  assert.equal(none.ok, true);
  assert.equal(none.class, 'not-applicable');
  assert.equal(assertionRow('caps', none).contributesToPassed, false);
  const measured = capArchiveGate({ capArchives: 0, evictArchives: 2, verdictArchives: 1, archiveTotal: 3 });
  assert.equal(measured.ok, true);
  assert.equal(measured.class, 'measured');
  const failed = capArchiveGate({ capArchives: 1, archiveTotal: 1 });
  assert.equal(failed.ok, false);
  // The --perturb-journal-caps shape: a cap invented in memory with no archive
  // behind it is still red, never not-applicable.
  const perturbed = capArchiveGate({ capArchives: 1, archiveTotal: 0 });
  assert.equal(perturbed.ok, false);
});

test('audit 14 item 5: replacementAccounting 0 == 0 is not-applicable', () => {
  const gate = replacementAccounting({ arm: 'racoons', hostPruned: 0, sessionEvents: [], journal: {
    appliedRemovals: 0, landedEntries: 0, appliedForgets: 0, rewinds: 0,
  } });
  assert.equal(gate.ok, true);
  assert.equal(gate.class, 'not-applicable');
  assert.equal(assertionRow('replacement', gate).contributesToPassed, false);
  const measured = replacementAccounting({ arm: 'racoons', hostPruned: 0, sessionEvents: [
    { type: 'tool/result', surfaceOp: { op: 'replace' } },
  ], journal: { appliedRemovals: 1, landedEntries: 0, appliedForgets: 0, rewinds: 0 } });
  assert.equal(measured.ok, true);
  assert.equal(measured.class, 'measured');
});

test('audit 14 item 5: the host compaction lane with no compaction request is not-applicable', () => {
  const none = hostCompactionLaneOutcome([]);
  assert.equal(none.ok, true);
  assert.equal(none.class, 'not-applicable');
  assert.equal(assertionRow('lane', none).contributesToPassed, false);
  const measured = hostCompactionLaneOutcome([
    { kind: 'compaction', matched: 'compaction-summary-01' },
    { kind: 'post-compaction', matched: 'replay-post-compaction' },
  ]);
  assert.equal(measured.ok, true);
  assert.equal(measured.class, 'measured');
  const failed = hostCompactionLaneOutcome([{ kind: 'compaction', matched: 'turn-01-tr1' }]);
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /matched a record row/u);
});

test('audit 14 item 5: loopbackGate with no request-shaped record is not-applicable', () => {
  const none = loopbackGate({});
  assert.equal(none.ok, true);
  assert.equal(none.class, 'not-applicable');
  assert.equal(none.requestRecords, 0);
  assert.equal(assertionRow('loopback', none).contributesToPassed, false);
  const contentOnly = loopbackGate({ sessionEvents: [
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'http://127.0.0.1:4173' }] } } },
  ] });
  assert.equal(contentOnly.class, 'not-applicable');
  const measured = loopbackGate({ stdoutLines: [
    { type: 'request/header', data: { header: { baseUrl: 'https://api.deepseek.com/v1' } } },
  ] });
  assert.equal(measured.ok, true);
  assert.equal(measured.class, 'measured');
  assert.equal(measured.requestRecords, 1);
  const failed = loopbackGate({ stdoutLines: [
    { type: 'request/header', data: { header: { baseUrl: 'http://127.0.0.1:8080/v1' } } },
  ] });
  assert.equal(failed.ok, false);
  assert.equal(failed.class, 'failed');
});

test('audit 14 item 5: the request-log parse row is not-applicable with no log', () => {
  const absent = jsonLineGate([{ file: 'requests.jsonl', present: false, bytes: 0, malformed: [] }], 'request log');
  assert.equal(absent.ok, true);
  assert.equal(absent.class, 'not-applicable');
  assert.equal(assertionRow('request log', absent).contributesToPassed, false);
  const empty = jsonLineGate([{ file: 'requests.jsonl', present: true, bytes: 0, malformed: [] }], 'request log');
  assert.equal(empty.ok, true);
  assert.equal(empty.class, 'vacuous');
  const parsed = jsonLineGate([{ file: 'requests.jsonl', present: true, bytes: 12, malformed: [] }], 'request log');
  assert.equal(parsed.class, 'measured');
});

test('audit 14 item 7: the stale await-main and runbook sentences are gone', () => {
  for (const file of ['bench-run.mjs', 'loopback-gate.mjs', 'manifest-gate.mjs']) {
    const text = readFileSync(join(BENCH_DIR, file), 'utf8');
    assert.doesNotMatch(text, /ends (?:in|with) (?:a top-level )?`?await main\(\)`?/u, file);
  }
  const runbook = readFileSync(join(BENCH_DIR, 'runbook.md'), 'utf8');
  assert.doesNotMatch(runbook, /every scripted reply was consumed/u);
  assert.match(runbook, /consumed prefix N of M scripted replies/u);
  assert.doesNotMatch(runbook, /deletes it plus `DEEPSEEK_\*` and `RIG_\*` from the child/u);
  assert.match(runbook, /then sets only what this run means to/u);
  const reference = readFileSync(join(BENCH_DIR, 'reference.md'), 'utf8');
  assert.match(reference, /capIgnoredSource/u);
});

test('audit 13 item 5: a series short of the session log\'s assistant turns fails', () => {
  const gate = contextSeriesCoverage({ series: [100, 200], assistantTurns: 3, peakRequest: 2 });
  assert.equal(gate.ok, false);
  assert.equal(gate.class, 'failed');
  assert.match(gate.detail, /series is short/u);
  assert.match(gate.detail, /2 turn\(s\)/u);
  assert.match(gate.detail, /3 assistant turn\(s\)/u);
});

test('audit 13 item 5: a series covering every assistant turn passes as measured', () => {
  const gate = contextSeriesCoverage({ series: [100, 200, 300], assistantTurns: 3, peakRequest: 3 });
  assert.equal(gate.ok, true);
  assert.equal(gate.class, 'measured');
  assert.match(gate.detail, /3 turn\(s\) for 3 assistant turn\(s\)/u);
});

test('audit 13 item 6: a stop-on-compaction 1-start/0-end pairing is stopped-expected, not red', () => {
  const compaction = { count: 1, ends: 0, atRequests: [3] };
  const agree = compactionAgreementGate({
    compaction, context: { series: [100, 200], peak: 200 }, stoppedOnCompaction: true,
  });
  assert.equal(agree.ok, true);
  assert.equal(agree.class, 'stopped-expected');
  assert.match(agree.detail, /kill cut the summarization/u);
  const closed = compactionClosedGate({ compaction, stoppedOnCompaction: true });
  assert.equal(closed.ok, true);
  assert.equal(closed.class, 'stopped-expected');
});

test('audit 13 item 6: the same 1-start/0-end pairing without the stop flag is red', () => {
  const compaction = { count: 1, ends: 0, atRequests: [3] };
  const agree = compactionAgreementGate({
    compaction, context: { series: [100, 200], peak: 200 }, stoppedOnCompaction: false,
  });
  assert.equal(agree.ok, false);
  const closed = compactionClosedGate({ compaction, stoppedOnCompaction: false });
  assert.equal(closed.ok, false);
  assert.match(closed.detail, /1 compaction\/start but 0 compaction\/end/u);
});

test('audit 13 item 7: every assertion row carries class and contributesToPassed', () => {
  const measured = assertionRow('measured', true);
  assert.equal(measured.class, 'measured');
  assert.equal(measured.contributesToPassed, true);
  const vacuous = assertionRow('vacuous', { ok: true, class: 'vacuous', detail: 'empty population' });
  assert.equal(vacuous.class, 'vacuous');
  assert.equal(vacuous.contributesToPassed, false);
  const failed = assertionRow('failed', 'a real failure');
  assert.equal(failed.class, 'failed');
  assert.equal(failed.contributesToPassed, false);
  const summary = assertionSummaryOf([measured, vacuous, failed]);
  assert.deepEqual(summary, {
    total: 3, measured: 1, failed: 1, vacuous: 1, notApplicable: 0, void: 0, stoppedExpected: 0,
  });
});

test('audit 14 item 3: --allow-zero-reasoning is a void row and never inflates measured', () => {
  const counts = reasoningCountsOf([assistantRow({ seq: 1 }), assistantRow({ seq: 2 })]);
  const gate = reasoningGate({ provider: 'deepseek-official', counts, allowZeroReasoning: true });
  assert.equal(gate.ok, true);
  assert.equal(gate.voided, true);
  const row = assertionRow('reasoning: the session carries the agent\'s reasoning (ADR-0045)', {
    ok: gate.ok,
    class: gate.voided ? 'void' : 'measured',
    detail: gate.detail,
  });
  assert.equal(row.ok, true);
  assert.equal(row.class, 'void');
  assert.equal(row.contributesToPassed, false);
  const summary = assertionSummaryOf([row, assertionRow('measured', true)]);
  assert.equal(summary.measured, 1);
  assert.equal(summary.void, 1);
  const line = passLineFor({
    arm: 'racoons', provider: 'deepseek-official', results: [row], citableAs: gate.citableAs,
    denySkipped: true, verdict: 'pass', legBScored: 'pass',
  });
  assert.match(line, /0 measured, 0 vacuous, 0 not applicable, 1 void/u);
  assert.match(line, /citableAs="none \(no reasoning measured\)"/u);
});

test('audit 13 item 7: the known vacuous rows are marked vacuous', () => {
  // 1. recall at 0 publishes is covered above (not-applicable).
  // 2. replay table asks at 0 asks.
  const asks = tableAskOutcome({ arm: 'racoons', asks: [] });
  assert.equal(asks.ok, true);
  assert.equal(asks.class, 'vacuous');
  assert.equal(assertionRow('asks', asks).contributesToPassed, false);
  // 3. tool failures at 0 expected.
  const failures = toolFailureOutcome({
    observed: { count: 0, by_code: {}, by_tool: {} },
    expected: { count: 0, by_code: {}, by_tool: {} },
  });
  assert.equal(failures.ok, true);
  assert.equal(failures.class, 'vacuous');
  // 4. pressure rows at 0 compactions.
  const agree = compactionAgreementGate({
    compaction: { count: 0, ends: 0, atRequests: [] },
    context: { series: [100], peak: 100 },
  });
  assert.equal(agree.ok, true);
  assert.equal(agree.class, 'vacuous');
  const closed = compactionClosedGate({ compaction: { count: 0, ends: 0 } });
  assert.equal(closed.ok, true);
  assert.equal(closed.class, 'vacuous');
});

test('audit 13 item 7: a tool failure the script did not expect is still red at 0 expected', () => {
  const gate = toolFailureOutcome({
    observed: { count: 1, by_code: { FS_EDIT_NOT_FOUND: 1 }, by_tool: { edit: 1 } },
    expected: { count: 0, by_code: {}, by_tool: {} },
    firstUnexpected: 'edit FS_EDIT_NOT_FOUND boom',
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.class, 'failed');
  assert.match(gate.detail, /first unexpected/u);
});

test('audit 13 item 8: the PASS line states citableAs', () => {
  const line = passLineFor({
    arm: 'racoons',
    provider: 'deepseek-official',
    results: [
      assertionRow('a', true),
      assertionRow('b', { ok: true, class: 'vacuous' }),
      assertionRow('c', { ok: true, class: 'not-applicable' }),
    ],
    citableAs: 'none (no reasoning measured)',
    denySkipped: false,
    verdict: 'pass',
    legBScored: 'expected',
  });
  assert.match(line, /^PASS racoons \(deepseek-official\): 3 assertion\(s\)/u);
  assert.match(line, /1 measured, 1 vacuous, 1 not applicable/u);
  assert.match(line, /citableAs="none \(no reasoning measured\)"/u);
  assert.match(line, /deny probe pass \(leg B expected on the real route\)/u);
});

test('2026-11-09 audit item 1: a budget stop is labelled censored by budget', () => {
  const label = runCitableAs({
    stopReason: 'budget',
    citableAs: 'measurement (product effect only; reasoning wire unmeasured)',
    failures: [],
    largestCheckpointReached: 8,
    benchDoneFound: false,
  });
  assert.equal(label, 'none (censored partial by budget at k=8; benchDone.found=false)');
  assert.match(label, /censored partial by budget/u);
  assert.doesNotMatch(label, /^measurement/u);
});

test('dsh record defect A: an incomplete ask lane labels the true total a lower bound', () => {
  // A found journal is not a complete ask lane: an unmeasured prune table or an
  // unparsed line leaves the grant's true total a lower bound. The run label
  // says so on a green run and on a budget stop alike.
  assert.equal(runCitableAs({
    stopReason: null,
    citableAs: 'measurement (reasoning measured)',
    failures: [],
    askComplete: false,
  }), 'measurement (reasoning measured); true total is a lower bound (ask lane incomplete)');
  assert.equal(runCitableAs({
    stopReason: 'budget',
    citableAs: 'measurement (reasoning measured)',
    failures: [],
    largestCheckpointReached: 13,
    benchDoneFound: true,
    askComplete: false,
  }), 'none (censored partial by budget at k=13; benchDone.found=true)'
    + '; true total is a lower bound (ask lane incomplete)');
  // A complete ask lane keeps the label unchanged.
  assert.equal(runCitableAs({
    stopReason: null,
    citableAs: 'measurement (reasoning measured)',
    failures: [],
    askComplete: true,
  }), 'measurement (reasoning measured)');
});

test('2026-11-09 record defect B: an arm with no ask lane states no lower bound', () => {
  // The vanilla arm mounts nothing, so it configures no ask lane at all. An
  // absent journal there is not an incomplete lane: `askComplete` is null and
  // the run label carries no lower-bound caveat, on a green run and on a
  // budget stop alike.
  assert.equal(askLaneCompleteness({ askLaneConfigured: false, askLane: null }), null);
  assert.equal(runCitableAs({
    stopReason: null,
    citableAs: 'measurement (product effect only; no removal measured)',
    failures: [],
    askComplete: askLaneCompleteness({ askLaneConfigured: false, askLane: null }),
  }), 'measurement (product effect only; no removal measured)');
  assert.equal(runCitableAs({
    stopReason: 'budget',
    citableAs: 'measurement (product effect only; no removal measured)',
    failures: [],
    largestCheckpointReached: 8,
    benchDoneFound: true,
    askComplete: null,
  }), 'none (censored partial by budget at k=8; benchDone.found=true)');
});

test('2026-11-09 record defect B: a configured but incomplete ask lane keeps the caveat', () => {
  // A mounted arm whose journal is absent, or whose prune table or line was not
  // measured, still bounds the true total: `false`, and the label says so.
  assert.equal(askLaneCompleteness({ askLaneConfigured: true, askLane: null }), false);
  assert.equal(askLaneCompleteness({
    askLaneConfigured: true,
    askLane: { known: true, pruneAsks: 1, unparsed: 0 },
  }), false);
  assert.equal(askLaneCompleteness({
    askLaneConfigured: true,
    askLane: { known: true, pruneAsks: 0, unparsed: 1 },
  }), false);
  // A complete lane is true and the label is unchanged.
  assert.equal(askLaneCompleteness({
    askLaneConfigured: true,
    askLane: { known: true, pruneAsks: 0, unparsed: 0 },
  }), true);
  assert.equal(runCitableAs({
    stopReason: null,
    citableAs: 'measurement (product effect only; no removal measured)',
    failures: [],
    askComplete: askLaneCompleteness({
      askLaneConfigured: true,
      askLane: { known: true, pruneAsks: 0, unparsed: 1 },
    }),
  }), 'measurement (product effect only; no removal measured)'
    + '; true total is a lower bound (ask lane incomplete)');
});

test('2026-11-09 audit item 1: a grant that fires after the child exited does not claim a kill', () => {
  // The final poll can cross the ceiling after the child exited; `reap` then
  // finds no live tree. The note must say the ceiling was crossed at that read,
  // never that the tree was killed or that the task never completed.
  const late = budgetStopNote({ killLanded: false, benchDoneFound: false });
  assert.match(late, /at the final read after the child had already exited/u);
  assert.match(late, /nothing needed killing/u);
  assert.doesNotMatch(late, /the tree was killed/u);
  assert.doesNotMatch(late, /never completed/u);
  // A done event present at that moment is stated, never contradicted.
  const lateDone = budgetStopNote({ killLanded: false, benchDoneFound: true });
  assert.match(lateDone, /benchDone\.found=true/u);
  assert.doesNotMatch(lateDone, /never completed/u);
  // A landed kill keeps the old statement.
  const killed = budgetStopNote({ killLanded: true, benchDoneFound: false });
  assert.match(killed, /the tree was killed/u);
  assert.match(killed, /task never completed/u);
  // The gate detail carries the same distinction.
  const [gate] = tokenGrantGates({
    tokenGrant: 50_000_000,
    tokenWatch: { tokenFired: true, observedPromptTokens: 49_000_000, trueTotalTokens: 50_100_000,
      polls: 7, error: null, killLanded: false },
    usageCoverage: { assistantTurns: 0, usageRows: 0, missingRows: 0, missingSeqs: [], reconciled: true },
  });
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /nothing needed killing/u);
  assert.doesNotMatch(gate.detail, /the tree was killed/u);
});

test('ISSUE-235 item 5: a zero-judged read boundary is not a measured pass', () => {
  const empty = readBoundaryGate({ judged: 0, violations: [] });
  assert.equal(empty.ok, true);
  assert.equal(empty.class, 'not-applicable');
  assert.match(empty.detail, /not exercised/u);
  const row = assertionRow('read boundary: no call names a path', empty);
  assert.equal(row.class, 'not-applicable');
  assert.equal(row.contributesToPassed, false);
  // A nonzero judged clean boundary keeps the measured pass.
  assert.equal(readBoundaryGate({ judged: 3, violations: [] }), true);
  // The run-level label states that the check was not exercised.
  assert.equal(runCitableAs({
    stopReason: null,
    citableAs: 'measurement (reasoning measured)',
    failures: [],
    readBoundaryJudged: 0,
  }), 'measurement (reasoning measured); read boundary not exercised (judged: 0)');
  assert.equal(runCitableAs({
    stopReason: null,
    citableAs: 'measurement (reasoning measured)',
    failures: [],
    readBoundaryJudged: 2,
  }), 'measurement (reasoning measured)');
});

test('ISSUE-235 item 5: the evidence dir is not a world root but naming it is still a violation', () => {
  assert.deepEqual(readWorldRoots({ world: null, armDir: join('C:', 'arm') }), [join('C:', 'arm')]);
  assert.deepEqual(readWorldRoots({ world: join('C:', 'world'), armDir: join('C:', 'world', 'arm') }),
    [join('C:', 'world')]);
  const root = mkdtempSync(join(tmpdir(), 'racoons-evidence-root-'));
  try {
    const arm = join(root, 'arm');
    const evidence = join(root, 'evidence');
    mkdirSync(arm, { recursive: true });
    mkdirSync(evidence, { recursive: true });
    const call = (seq, file) => ({ type: 'tool/call', seq,
      data: { name: 'read', callId: `call-${String(seq)}`,
        arguments: JSON.stringify({ file_path: file }) } });
    const report = classifyToolCalls({
      sessionEvents: [
        call(1, join(arm, 'kept.md')),
        call(2, join(evidence, 'journal.jsonl')),
      ],
      workDir: arm,
      worldRoots: readWorldRoots({ world: null, armDir: arm }),
      campaignRoot: campaignRootFor({ worldRoot: null, root, armDir: arm, evidenceDir: evidence }),
      evidenceDir: evidence,
      scratch: [],
    });
    assert.equal(report.judged, 2);
    assert.equal(report.inside, 1, 'the arm file is still inside; the evidence read is not');
    assert.equal(report.violations.length, 1);
    assert.equal(report.violations[0].scope, 'evidence-path');
    assert.equal(report.violations[0].resolved, join(evidence, 'journal.jsonl'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('2026-11-09 audit item 6: a failed assertion demotes the label and names the first failure', () => {
  const label = runCitableAs({
    stopReason: null,
    citableAs: 'measurement (product effect only; reasoning wire unmeasured)',
    failures: [
      { name: 'fidelity: tool failures are exactly the scripted constant' },
      { name: 'usage: every assistant turn carries a usage row' },
    ],
  });
  assert.equal(label, 'none (2 assertion(s) failed; first: '
    + 'fidelity: tool failures are exactly the scripted constant)');
  assert.match(label, /^none \(/u);
  // A green run still keeps the label the reasoning/removal gates built.
  assert.equal(runCitableAs({
    stopReason: null,
    citableAs: 'measurement (reasoning measured)',
    failures: [],
  }), 'measurement (reasoning measured)');
});

test('item 10: the snapshot reads once and hashes the bytes it parsed', () => {
  let reads = 0;
  const readChangedSecondTime = () => {
    reads += 1;
    return reads === 1 ? Buffer.from('{"a":1}\n') : Buffer.from('{"a":2}\n');
  };
  const snapshot = readJsonLinesSnapshot('changed.jsonl', readChangedSecondTime);
  assert.equal(reads, 1);
  assert.deepEqual(snapshot.events, [{ a: 1 }]);
  assert.equal(snapshot.bytes, 8);
  assert.equal(snapshot.sha256, hex('{"a":1}\n'));
});

test('item 10: an absent log is stated, never invented', () => {
  let reads = 0;
  const absent = () => {
    reads += 1;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const snapshot = readJsonLinesSnapshot('absent.jsonl', absent);
  assert.equal(reads, 1);
  assert.equal(snapshot.present, false);
  assert.equal(snapshot.sha256, null);
  assert.deepEqual(snapshot.events, []);
});

test('item 2 fixture: compactionEvents reads two starts and two ends', () => {
  const events = [
    { type: 'compaction/start', seq: 4 },
    { type: 'compaction/end', seq: 5 },
    { type: 'compaction/start', seq: 9 },
    { type: 'compaction/end', seq: 10 },
  ];
  const compaction = compactionEvents(events);
  assert.equal(compaction.count, 2);
  assert.equal(compaction.ends, 2);
  assert.deepEqual(compaction.atSeqs, [4, 9]);
});

test('audit 15 item 3: preflight fails on no pruner row or a zero disable count for racoons', () => {
  const missingRow = preflightPrunerRequirement({ arm: 'racoons', rows: [] });
  assert.equal(missingRow.ok, false);
  assert.equal(missingRow.state, 'disabled');
  assert.match(missingRow.detail, /no tool-result-pruner row/u);
  const enabled = preflightPrunerRequirement({
    arm: 'racoons', rows: [{ row: 'tool-result-pruner', disabled: false }],
  });
  assert.equal(enabled.ok, false);
  assert.match(enabled.detail, /enabled/u);
  const disabled = preflightPrunerRequirement({
    arm: 'racoons', rows: [{ row: 'tool-result-pruner', disabled: true }],
  });
  assert.equal(disabled.ok, true);
  // A partial disable is the ADR-0041 shape too: every copy must be off.
  const partial = preflightPrunerRequirement({
    arm: 'racoons',
    rows: [{ row: 'tool-result-pruner', disabled: true }, { row: 'tool-result-pruner', disabled: false }],
  });
  assert.equal(partial.ok, false);
  assert.match(partial.detail, /still enabled/u);
  // The launcher refuses on the verdict before it can print PREFLIGHT PASS.
  const source = readFileSync(join(BENCH_DIR, 'bench-run.mjs'), 'utf8');
  assert.match(source,
    /preflightPrunerRequirement\(\{\s*arm: opts\.arm, allowHostPruner: opts\.allowHostPruner, rows: prunerRows,?\s*\}\)/u);
  assert.match(source,
    /if \(!prunerVerdict\.ok\) \{\s*process\.stderr\.write\(`preflight FAIL: \$\{prunerVerdict\.detail\}\\n`\);\s*process\.exit\(1\);/u);
});

test('host pruner arm rule: racoons records disabled and writes the row', () => {
  assert.equal(hostPrunerState('racoons'), 'disabled');
  assert.equal(hostPrunerState('racoons', false), 'disabled');
  // The ADR-0041 opt-out is the only way the product arm leaves the host on.
  assert.equal(hostPrunerState('racoons', true), 'host-default');
  const record = hostPrunerRecord({
    arm: 'racoons',
    patchTally: { rows: 14, hostPrunerRows: 1 },
    isolation: { applied: true, source: 'dump.yml', rows: 1, disabledRows: 1, error: null },
    pruneEvents: 0,
    pruneShadowedTokens: 0,
  });
  assert.equal(record.state, 'disabled');
  assert.equal(record.disabled, true);
  assert.equal(record.asserted, true);
  assert.equal(record.optOut, null);
  assert.deepEqual(record.patch, { rows: 14, hostPrunerRows: 1 });
  assert.equal(record.composed.disabledRows, 1);
  assert.equal(preflightPrunerRequirement({
    arm: 'racoons', rows: [{ row: 'tool-result-pruner', disabled: true }],
  }).ok, true);
});

test('host pruner arm rule: vanilla records host-default and writes no row', () => {
  assert.equal(hostPrunerState('vanilla'), 'host-default');
  // On vanilla the flag changes nothing, so it is not a decision the run took.
  assert.equal(hostPrunerState('vanilla', true), 'host-default');
  const record = hostPrunerRecord({
    arm: 'vanilla',
    patchTally: { rows: 13, hostPrunerRows: 0 },
    isolation: { applied: false, source: 'dump.yml', rows: 1, disabledRows: 0, error: null },
    pruneEvents: 2,
    pruneShadowedTokens: 400,
  });
  assert.equal(record.state, 'host-default');
  assert.equal(record.disabled, false);
  // The session log's prune events are evidence on the control, not a claim.
  assert.equal(record.asserted, false);
  assert.equal(record.optOut, null);
  assert.deepEqual(record.patch, { rows: 13, hostPrunerRows: 0 });
  assert.equal(record.pruneEvents, 2);
  assert.equal(preflightPrunerRequirement({
    arm: 'vanilla', rows: [{ row: 'tool-result-pruner', disabled: false }],
  }).ok, true);
});

test('host pruner arm rule: a vanilla patch still carrying the row fails', () => {
  // The exact shape a launcher that kept the old run-wide disable would write.
  const planted = [
    '- id: session-persistence-jsonl',
    '  config:',
    '    compression: none',
    '- id: tool-result-pruner',
    '  disabled: true',
  ].join('\n');
  const tally = patchRowTally(planted);
  assert.equal(tally.hostPrunerRows, 1, 'the planted patch does carry the row');
  // The preflight assertion is where the mismatch fails: the control must show
  // no disabled copy, and a planted row composes as one.
  const verdict = preflightPrunerRequirement({
    arm: 'vanilla', rows: [{ row: 'tool-result-pruner', disabled: true }],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.state, 'host-default');
  assert.match(verdict.detail, /leaves the host pruner at its host default/u);
  // And the record built from that patch states the row it carried, so a reader
  // sees the mismatch instead of a bare boolean.
  const record = hostPrunerRecord({
    arm: 'vanilla',
    patchTally: tally,
    isolation: { applied: true, source: 'dump.yml', rows: 1, disabledRows: 1, error: null },
    pruneEvents: 0,
    pruneShadowedTokens: 0,
  });
  assert.equal(record.patch.hostPrunerRows, 1);
  assert.equal(record.composed.disabledRows, 1);
});

test('audit 15 item 4: the vanilla arm at zero table asks is vacuous too', () => {
  // The same empty population on either arm is the same thing: nothing was
  // answered. A vanilla leak is still red; the zero case is not a measured pass.
  const vanilla = tableAskOutcome({ arm: 'vanilla', asks: [] });
  assert.equal(vanilla.ok, true);
  assert.equal(vanilla.class, 'vacuous');
  assert.equal(assertionRow('asks', vanilla).contributesToPassed, false);
  assert.equal(tableAskOutcome({ arm: 'racoons', asks: [] }).class, 'vacuous');
  const leaked = tableAskOutcome({
    arm: 'vanilla', asks: [{ matched: 'prune-table-forgetall-01' }],
  });
  assert.equal(leaked.ok, false);
  assert.equal(leaked.class, 'failed');
});

test('audit 15 item 6: the compaction agreement words match slice(first - 1)', () => {
  // `series` is per conversation request, 1-based. The gate slices from the
  // NAMED request onward, so its words must not say "after" it: the named
  // request itself is in the compared span.
  const gate = compactionAgreementGate({
    compaction: { count: 1, ends: 1, atRequests: [2] },
    context: { series: [300, 250], peak: 300 },
  });
  assert.equal(gate.ok, true);
  assert.match(gate.detail, /at or after the compaction at request 2/u);
  assert.match(gate.detail, /smallest at or after 250 B/u);
});

// ── Fifteenth audit: the dsh live bench's evidence gaps ──────────────────────
//
// Offline only, like the rest of this file: temp dirs and pure gates.

test('fifteenth audit item 1: a vanilla evidence dir with a planted journal fails by name', (t) => {
  // The old `journal === null` for the vanilla arm skipped every scan, so the
  // control proved no mount (config) but not no removals (evidence). The scan
  // now runs on every run and this gate names what it found.
  const base = mkdtempSync(join(tmpdir(), 'racoons-vanilla-scan-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const clean = journalState([base, join(base, 'racoons')], null);
  const green = vanillaEvidenceGate(clean);
  assert.equal(green.ok, true);
  assert.equal(green.class, 'measured');

  mkdirSync(join(base, 'racoons'), { recursive: true });
  const events = join(base, 'racoons', 'cremator-events.jsonl');
  writeFileSync(events, `${JSON.stringify({ kind: 'mounted', storageRoot: 'planted' })}\n`);
  const planted = vanillaEvidenceGate(journalState([base, join(base, 'racoons')], null));
  assert.equal(planted.ok, false);
  assert.match(planted.detail, /cremator-events\.jsonl/u);

  // A ledger alone is product evidence too.
  rmSync(events);
  const ledger = join(base, 'racoons', 'ledger.sqlite');
  writeFileSync(ledger, '');
  const ledgerOnly = vanillaEvidenceGate(journalState([base, join(base, 'racoons')], null));
  assert.equal(ledgerOnly.ok, false);
  assert.match(ledgerOnly.detail, /ledger\.sqlite/u);

  // The replace-row side: one stored tool/result replace on the control with
  // the host pruner off is red; none is not-applicable, never a measured pass.
  const replace = replacementAccounting({ arm: 'vanilla', hostPruned: 0, journal: null,
    sessionEvents: [{ type: 'tool/result', surfaceOp: { op: 'replace' } }] });
  assert.equal(replace.ok, false);
  assert.match(replace.detail, /1 tool\/result replacement/u);
  const none = replacementAccounting({ arm: 'vanilla', hostPruned: 0, journal: null, sessionEvents: [] });
  assert.equal(none.ok, true);
  assert.equal(none.class, 'not-applicable');
});

test('fifteenth audit item 2: a zero-removal run is not citable as a removal measurement', () => {
  const zero = removalSummary({ arm: 'racoons',
    journal: { appliedRemovals: 0, landedEntries: 0, appliedForgets: 0 } });
  assert.equal(zero.applied, 0);
  assert.equal(zero.exercised, false);
  assert.match(zero.reason, /not a product removal/u);
  assert.equal(removalCitable('measurement (product effect only; reasoning wire unmeasured)', zero),
    'measurement (product effect only; no removal measured)');
  // A `none (…)` label keeps its own reason; the removal qualifier is not a
  // second reason stacked on the first.
  assert.equal(removalCitable('none (no reasoning measured)', zero), 'none (no reasoning measured)');

  const applied = removalSummary({ arm: 'racoons',
    journal: { appliedRemovals: 2, landedEntries: 1, appliedForgets: 0 } });
  assert.equal(applied.applied, 3);
  assert.equal(applied.exercised, true);
  assert.equal(removalCitable('measurement (product effect only; reasoning wire unmeasured)', applied),
    'measurement (product effect only; reasoning wire unmeasured)');
  assert.equal(removalSummary({ arm: 'vanilla', journal: null }).applied, 0);

  const line = passLineFor({
    arm: 'racoons', provider: 'deepseek-official', results: [assertionRow('a', true)],
    citableAs: removalCitable('measurement (product effect only)', zero), denySkipped: false,
    verdict: 'pass', legBScored: 'expected', removals: zero.applied, compacted: 0,
  });
  assert.match(line, /, removals=0/u);
  assert.match(line, /, compacted=0/u);
  assert.match(line, /no removal measured/u);
  const measured = passLineFor({
    arm: 'racoons', provider: 'deepseek-official', results: [assertionRow('a', true)],
    citableAs: 'measurement (reasoning measured)', denySkipped: false, verdict: 'pass',
    legBScored: 'expected', removals: 3, compacted: 2,
  });
  assert.match(measured, /, removals=3/u);
  assert.match(measured, /, compacted=2/u);
});

test('fifteenth audit item 4: the compaction closure row is registered outside the replay block', () => {
  // The row used to live inside `if (replay !== null)`, so a live run
  // that opened a compaction and never closed it was green.
  const source = readFileSync(join(BENCH_DIR, 'bench-run.mjs'), 'utf8');
  const gateIndex = source.indexOf("check('compaction: every compaction the host opened closed'");
  const replayIndex = source.indexOf('let replayPrefix = null;');
  assert.ok(gateIndex > 0, 'the closure row is registered');
  assert.ok(replayIndex > 0, 'the replay block is found');
  assert.ok(gateIndex < replayIndex, 'the closure row is registered before the replay block');
  // A live-shaped run: a start with no end, no stop flag. Red.
  const live = compactionClosedGate({ compaction: { count: 1, ends: 0 } });
  assert.equal(live.ok, false);
  assert.equal(live.class, 'failed');
  // The same shape is the intended stop only when the flag asked for it.
  assert.equal(compactionClosedGate({ compaction: { count: 1, ends: 0 }, stoppedOnCompaction: true }).class,
    'stopped-expected');
});

test('fifteenth audit item 5: a paid route needs --manifest and the arm tree must match image.digest', () => {
  const missing = paidRouteManifestGate({ paid: true, manifest: null });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /--manifest/u);
  assert.equal(paidRouteManifestGate({ paid: true, manifest: 'dev/bench/manifests/x.json' }).ok, true);
  assert.equal(paidRouteManifestGate({ paid: false, manifest: null }).ok, true);

  const digest = 'a'.repeat(64);
  const manifest = { image: { digest } };
  assert.equal(armTreeGate({ manifest, digest }).ok, true);
  const mismatch = armTreeGate({ manifest, digest: 'b'.repeat(64), files: 1787 });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.detail, /image\.digest/u);
  assert.match(mismatch.detail, /1787/u);
  assert.equal(armTreeGate({ manifest: {}, digest }).ok, false);
  assert.equal(armTreeGate({ manifest, digest: null }).ok, false);
});

/** One minimal ledger file shaped like the shipped one, closed before it is read. */
function writeRemovalLedger(t, { appliedRows = [], abandonedRows = [], recalls = [] }) {
  const base = mkdtempSync(join(tmpdir(), 'racoons-removal-ledger-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const path = join(base, 'ledger.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE ledger_events (kind TEXT, intent_id TEXT);'
    + 'CREATE TABLE application_removals (intent_id TEXT, rule_id TEXT, removal_id TEXT,'
    + ' recall_id TEXT, operation_kind TEXT, episode_id TEXT);'
    + 'CREATE TABLE recalls (recall_id TEXT);'
    + 'CREATE TABLE recall_parts (recall_id TEXT, part_index INTEGER, source_sha256 TEXT,'
    + ' source_byte_length INTEGER, blob_sha256 TEXT);');
  for (const recall of recalls) db.prepare('INSERT INTO recalls VALUES (?)').run(recall);
  const insert = db.prepare('INSERT INTO application_removals VALUES (?, ?, ?, ?, ?, ?)');
  const add = (intent, recall, index, applied) => {
    db.prepare('INSERT INTO ledger_events VALUES (?, ?)').run('prepared', intent);
    if (applied) db.prepare('INSERT INTO ledger_events VALUES (?, ?)').run('applied', intent);
    insert.run(intent, 'rule', `rem-${String(index)}`, recall, 'forget', null);
  };
  appliedRows.forEach((recall, index) => add(`intent-a${String(index)}`, recall, index, true));
  abandonedRows.forEach((recall, index) => add(`intent-b${String(index)}`, recall, index, false));
  db.close();
  return path;
}

test('fifteenth audit item 6: an applied removal needs a ledger row and a recall row', (t) => {
  const path = writeRemovalLedger(t, {
    appliedRows: ['recall-r1'], abandonedRows: ['recall-r2'], recalls: ['recall-r1'],
  });
  const state = ledgerState(path);
  assert.equal(state.present, true);
  assert.equal(state.readable, true);
  // The prepare-time row of an abandoned intent is NOT an applied removal.
  assert.equal(state.appliedRemovals.total, 1);
  assert.deepEqual(state.appliedRemovals.recallIds, ['recall-r1']);
  const green = removalLedgerGate({
    journal: { appliedRemovals: 1 }, applied: state.appliedRemovals, ledgerRecallIds: state.recallIds,
  });
  assert.equal(green.ok, true);
  assert.equal(green.class, 'measured');

  // A journal removal with no ledger row is red, by both counts.
  const missing = removalLedgerGate({
    journal: { appliedRemovals: 2 }, applied: state.appliedRemovals, ledgerRecallIds: state.recallIds,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /journal records 2 applied removal\(s\); the ledger holds 1/u);

  // An applied row whose recall id is absent from `recalls` has no restore path.
  const path2 = writeRemovalLedger(t, { appliedRows: ['recall-r3'], recalls: ['recall-r1'] });
  const state2 = ledgerState(path2);
  assert.equal(state2.readable, true);
  const absent = removalLedgerGate({
    journal: { appliedRemovals: 1 }, applied: state2.appliedRemovals, ledgerRecallIds: state2.recallIds,
  });
  assert.equal(absent.ok, false);
  assert.match(absent.detail, /absent from the ledger's recalls table/u);
});

test('fifteenth audit item 7: --plugin-entry is refused on the vanilla arm', () => {
  assert.equal(vanillaPluginEntryRefusal({ arm: 'vanilla', pluginEntry: 'C:/x/plugin.js' }),
    '--plugin-entry has no effect on --arm vanilla (the vanilla arm loads no mount); '
      + 'refusing the combination rather than ignoring it');
  assert.equal(vanillaPluginEntryRefusal({ arm: 'vanilla', pluginEntry: null }), null);
  assert.equal(vanillaPluginEntryRefusal({ arm: 'racoons', pluginEntry: 'C:/x/plugin.js' }), null);
  // `--preflight` composes a config and mounts nothing, so it is exempt; the
  // silent act a launch would perform is what the refusal names.
  assert.equal(vanillaPluginEntryRefusal({ arm: 'vanilla', pluginEntry: 'C:/x/plugin.js', preflight: true }),
    null);
});

// ---------------------------------------------------------------------------
// ADR-0050: the absolute prune bar and the off entry ask. The launch config
// names the shape; these rows hold that the launcher carries it unchanged and
// that the record says which shape ran.
// ---------------------------------------------------------------------------

const LAUNCHER = join(BENCH_DIR, 'bench-run.mjs');

/** The mount keys `mountConfig` reads, every one present and at its default. */
function mountOpts(overrides = {}) {
  return {
    windowTokens: null,
    pruneThresholdTokens: null,
    entryAskBatchSize: null,
    entryAskTrigger: null,
    entryAskGrammar: null,
    dedupeSupersededByReread: false,
    dedupeCallEcho: false,
    judgeTimeoutMs: null,
    ...overrides,
  };
}

test('ADR-0050: a 60000 bar beside a 400000 window both reach the mount config', () => {
  const config = mountConfig(mountOpts({ windowTokens: 400000, pruneThresholdTokens: 60000 }), null);
  assert.equal(config.pruneThresholdTokens, 60000);
  assert.equal(config.contextWindowTokens, 400000);
  // The bar is absolute, not the window halved: the launch plan's two numbers
  // must not be folded into the deprecated half-window rule.
  assert.notEqual(config.pruneThresholdTokens, config.contextWindowTokens / 2);
});

test('ADR-0050: an omitted bar leaves the key ABSENT, so the launcher invents none', () => {
  const config = mountConfig(mountOpts({ windowTokens: 400000 }), null);
  assert.equal(Object.hasOwn(config, 'pruneThresholdTokens'), false);
  assert.equal(config.contextWindowTokens, 400000);
});

test('ADR-0050: entryAskTrigger {mode: "off"} survives into the mount config', () => {
  const config = mountConfig(mountOpts({
    windowTokens: 400000, pruneThresholdTokens: 60000, entryAskTrigger: { mode: 'off' },
  }), null);
  // Written through unchanged: no bytes, no rewritten mode, no dropped key.
  assert.deepEqual(config.entryAskTrigger, { mode: 'off' });
});

test('ADR-0050: the facts name the bar and the off entry-ask mode', () => {
  const facts = mountConfigFacts({
    capBytes: 8192,
    capHeadBytes: 8192,
    sealMaxLatencyTurns: 1,
    pruneThresholdTokens: 60000,
    entryAskTrigger: { mode: 'off' },
  });
  assert.equal(facts.pruneThresholdTokens, 60000);
  assert.equal(facts.entryAskMode, 'off');
  // The existing facts keep their fields and shapes.
  assert.equal(facts.capIgnored, true);
  assert.deepEqual(facts.inertKeys, ['capBytes', 'capHeadBytes']);
  assert.equal(facts.sealBoundMatches, true);
});

test('ADR-0050: facts with no bar and no trigger state null and the off default', () => {
  const facts = mountConfigFacts({ capBytes: 8192, capHeadBytes: 8192, sealMaxLatencyTurns: 1 });
  assert.equal(facts.pruneThresholdTokens, null);
  assert.equal(facts.entryAskMode, 'off');
});

test('ADR-0050: zero, negative, fractional and non-numeric bars are refused by name', () => {
  for (const bad of ['0', '-1', '1.5', 'abc']) {
    const result = spawnSync(process.execPath,
      [LAUNCHER, '--arm', 'racoons', '--prune-threshold-tokens', bad],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 2, `--prune-threshold-tokens ${bad} must exit 2`);
    assert.match(result.stderr, /--prune-threshold-tokens takes a positive integer token count/u);
  }
});

test('the wall-clock kill timer defaults to OFF: killMs 0 and no armed box', () => {
  // Owner ruling 2026-11-08: the token grant is the only run cap. The default
  // must arm nothing, and `armKillBox` must say so with a null handle rather
  // than a timer that merely happens to be long.
  assert.equal(DEFAULTS.killMs, 0, 'the default is 0 (off)');
  let fired = 0;
  let scheduled = null;
  const timer = armKillBox({
    killMs: 0,
    onFire: () => { fired += 1; },
    schedule: (callback, ms) => { scheduled = { callback, ms }; return 'timer'; },
  });
  assert.equal(timer, null, '0 arms no timer');
  assert.equal(scheduled, null, 'the scheduler is never called at 0');
  assert.equal(fired, 0);
});

test('an explicit --kill-ms 0 is accepted and arms no timer', () => {
  assert.deepEqual(killMsValue('0'), { ok: true, value: 0 });
  assert.equal(armKillBox({ killMs: 0, onFire: () => {} }), null);
});

test('a positive --kill-ms still arms the box', () => {
  assert.deepEqual(killMsValue('1500'), { ok: true, value: 1500 });
  let fire = null;
  let scheduledMs = null;
  const timer = armKillBox({
    killMs: 1500,
    onFire: () => { fire = 'fired'; },
    schedule: (callback, ms) => { scheduledMs = ms; return { callback }; },
  });
  assert.notEqual(timer, null, 'a positive value returns a handle');
  assert.equal(scheduledMs, 1500, 'the box waits the value it was given');
  timer.callback();
  assert.equal(fire, 'fired', 'the armed box calls the kill path');
});

test('a negative or fractional --kill-ms is refused by name', () => {
  for (const bad of ['-1', '1.5', '-0.5']) {
    const parsed = killMsValue(bad);
    assert.equal(parsed.ok, false, `${bad} must not validate`);
    assert.match(parsed.message, /--kill-ms takes a non-negative integer/u);
    assert.throws(() => armKillBox({ killMs: Number(bad), onFire: () => {} }),
      /--kill-ms takes a non-negative integer/u);
  }
});

test('the launcher refuses a negative or fractional --kill-ms before any run', () => {
  for (const bad of ['-1', '1.5']) {
    const result = spawnSync(process.execPath, [LAUNCHER, '--arm', 'racoons', '--kill-ms', bad],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 2, `--kill-ms ${bad} must exit 2`);
    assert.match(result.stderr, /--kill-ms takes a non-negative integer/u);
  }
});

// ---------------------------------------------------------------------------
// The 2026-11-08 stop rule: checkpoint-path parsing, the strict read rule, the
// web preflight requirement, and the policy watchdog that reads the SAME
// SessionUsageWatch the grant reads. All offline: no dsh process, no provider.
// ---------------------------------------------------------------------------

test('checkpoint path: a relative file is accepted and separators are normalized', () => {
  assert.deepEqual(checkpointPathValue('docs/plans/x.md'), { ok: true, value: 'docs/plans/x.md' });
  assert.deepEqual(checkpointPathValue('docs\\plans\\x.md'), { ok: true, value: 'docs/plans/x.md' });
  assert.deepEqual(checkpointPathValue('./docs//plans/x.md'), { ok: true, value: 'docs/plans/x.md' });
});

test('checkpoint path: absolute, .. and directory forms are refused', () => {
  for (const bad of ['', '   ', 'C:/x.md', 'C:\\x.md', '/x.md', '\\x.md', '../x.md',
    'docs/../x.md', '..\\x.md', 'docs/']) {
    const parsed = checkpointPathValue(bad);
    assert.equal(parsed.ok, false, `${JSON.stringify(bad)} must not validate`);
    assert.match(parsed.message, /--stop-at-checkpoint/u);
  }
});

test('stop-after-compactions: a positive integer only', () => {
  assert.deepEqual(stopAfterCompactionsValue('2'), { ok: true, value: 2 });
  for (const bad of ['0', '-1', '1.5', 'abc', '']) {
    const parsed = stopAfterCompactionsValue(bad);
    assert.equal(parsed.ok, false, `${JSON.stringify(bad)} must not validate`);
    assert.match(parsed.message, /--stop-after-compactions takes a positive integer/u);
  }
});

// ---------------------------------------------------------------------------
// The expected deliverable list comes from the brief (or --deliverables), not
// from a hardcoded thirteen. The rows, k order, gate label and count all read
// the same derived list.
// ---------------------------------------------------------------------------

test('the 13-name default survives: the extended brief resolves to thirteen, in its order', () => {
  const extended = readFileSync(join(BENCH_DIR, 'bench-brief-extended.md'), 'utf8');
  const resolved = resolveBenchDeliverables({ briefText: extended, taskText: extended });
  assert.equal(resolved.paths.length, 13);
  assert.equal(resolved.source, 'brief');
  assert.equal(resolved.declared, true);
  assert.equal(resolved.paths[0], 'docs/plans/2026-10-27-extended-audit/00-index.md');
  assert.equal(resolved.paths[12], 'docs/plans/2026-10-27-extended-audit/12-corpus-zh.md');
});

test('the thirty-two-name brief resolves to thirty-two, and the gate says 32', {
  skip: !existsSync(join(BENCH_DIR, 'bench-brief-extended-32.md')),
}, () => {
  const brief = readFileSync(join(BENCH_DIR, 'bench-brief-extended-32.md'), 'utf8');
  const fence = brief.match(/```[a-z]*\r?\n([\s\S]*?)\r?\n```/u);
  const resolved = resolveBenchDeliverables({ briefText: brief, taskText: fence[1] });
  assert.equal(resolved.paths.length, 32);
  assert.equal(resolved.paths[12], 'docs/plans/2026-10-27-extended-audit/12-corpus-zh.md');
  assert.equal(resolved.paths[13], 'docs/plans/2026-10-27-extended-audit/13-adr-ledger.md');
  assert.equal(resolved.paths[31], 'docs/plans/2026-10-27-extended-audit/31-other-games-ledger.md');
  const rows = resolved.paths.map((path, index) => ({ k: index + 1, path, present: true }));
  const gate = deliverableGate({ rows, expected: resolved.paths.length });
  assert.equal(gate.name, 'task: the run wrote all 32 brief deliverables (32/32)');
  assert.equal(gate.ok, true);
});

test('a brief with no deliverable list keeps the thirteen table but is not gated', () => {
  const task = 'Read docs/project/index.md and fix it.';
  const resolved = resolveBenchDeliverables({ briefText: task, taskText: task });
  assert.equal(resolved.paths.length, 13);
  assert.equal(resolved.source, 'default');
  assert.equal(resolved.declared, false);
});

test('--deliverables wins over the brief and defaults to a newline file', () => {
  const brief = 'Deliverables:\na/01.md\nb/02.md\n';
  const resolved = resolveBenchDeliverables({
    briefText: brief,
    taskText: brief,
    deliverablesText: '# my list\nc/03.md\nd/04.md\n',
    sourceLabel: 'list.txt',
  });
  assert.deepEqual(resolved.paths, ['c/03.md', 'd/04.md']);
  assert.equal(resolved.source, 'deliverables-file');
  assert.equal(resolved.declared, true);
});

test('a 3-name brief list drives rows, k order, the gate and the result block end to end', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-deliverables-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  const paths = ['docs/plans/short/02-c.md', 'docs/plans/short/00-a.md', 'docs/plans/short/01-b.md'];
  const taskText = ['Write three records.', '', 'Deliverables, in order:',
    '`docs/plans/short/02-c.md`', '- docs/plans/short/00-a.md',
    '3. docs/plans/short/01-b.md'].join('\n');
  const briefText = `## Task text\n\n\`\`\`text\n${taskText}\n\`\`\`\n\n## Done criteria\n\nThree files exist.\n`;
  const resolved = resolveBenchDeliverables({ briefText, taskText });
  assert.equal(resolved.paths.length, 3);
  assert.equal(resolved.source, 'brief');
  assert.deepEqual(resolved.paths, paths);

  mkdirSync(join(work, 'docs', 'plans', 'short'), { recursive: true });
  // Written out of list order: the rows still follow the brief.
  writeFileSync(join(work, 'docs', 'plans', 'short', '01-b.md'), 'b\n');
  writeFileSync(join(work, 'docs', 'plans', 'short', '02-c.md'), 'c\n');
  writeFileSync(join(work, 'docs', 'plans', 'short', '00-a.md'), 'a\n');
  const rows = deliverableRowsFor(resolved.paths, work);
  assert.deepEqual(rows, [
    { k: 1, path: 'docs/plans/short/02-c.md', present: true },
    { k: 2, path: 'docs/plans/short/00-a.md', present: true },
    { k: 3, path: 'docs/plans/short/01-b.md', present: true },
  ]);
  const gate = deliverableGate({ rows, expected: resolved.paths.length });
  assert.equal(gate.ok, true);
  assert.equal(gate.name, 'task: the run wrote all 3 brief deliverables (3/3)');
  assert.equal(gate.created, 3);
  assert.deepEqual(gate.missing, []);
  const block = checkpointsBlock({ paths: resolved.paths, source: resolved.source, rows });
  assert.equal(block.expected, 3);
  assert.deepEqual(block.paths, paths);
  assert.equal(block.created, 3);
  assert.equal(block.largestReached, 3);
  assert.equal(block.largestCommonK, 3);

  // A missing expected file is red and names the path.
  rmSync(join(work, 'docs', 'plans', 'short', '00-a.md'));
  const incomplete = deliverableRowsFor(resolved.paths, work);
  const failed = deliverableGate({ rows: incomplete, expected: resolved.paths.length });
  assert.equal(failed.ok, false);
  assert.equal(failed.name, 'task: the run wrote all 3 brief deliverables (2/3)');
  assert.deepEqual(failed.missing, ['docs/plans/short/00-a.md']);
  assert.match(failed.detail, /missing \["docs\/plans\/short\/00-a\.md"\]/u);
  const partial = checkpointsBlock({ paths: resolved.paths, source: resolved.source, rows: incomplete });
  assert.equal(partial.created, 2);
  assert.equal(partial.filesPresent, 2);
  assert.equal(partial.largestReached, 3, 'k=3 is still reached when the middle file is missing');
  assert.equal(partial.largestCommonK, 1, 'k=2 is missing, so the contiguous prefix stops at k=1');
});

test('largestCommonK is the contiguous prefix, not the highest present k', () => {
  // Rows k=1,2,4: the highest present k is 4, but k=3 is missing, so the
  // contiguous prefix is 2. This is the 48-record pilot shape: 00 and 01
  // exist, 02 is missing, 03 and 04 exist.
  const paths = ['docs/plans/p/00.md', 'docs/plans/p/01.md', 'docs/plans/p/02.md',
    'docs/plans/p/03.md'];
  const rows = [
    { k: 1, path: paths[0], present: true },
    { k: 2, path: paths[1], present: true },
    { k: 4, path: paths[3], present: true },
  ];
  assert.equal(contiguousPrefixK(rows), 2);
  const block = checkpointsBlock({ paths, source: 'brief', rows });
  assert.equal(block.largestReached, 4);
  assert.equal(block.largestCommonK, 2);
  assert.equal(block.created, 3);
  assert.equal(block.filesPresent, 3);
});

test('the censored label states the derived denominator', () => {
  assert.equal(runCitableAs({
    stopReason: 'checkpoint',
    citableAs: 'measurement (reasoning measured)',
    failures: [],
    largestCheckpointReached: 2,
    expectedDeliverables: 3,
    benchDoneFound: false,
  }), 'none (censored partial at k=2 of 3; benchDone.found=false)');
  // The historical shape is unchanged when the list is unknown.
  assert.equal(runCitableAs({
    stopReason: 'checkpoint',
    citableAs: 'measurement (reasoning measured)',
    failures: [],
    largestCheckpointReached: 2,
    benchDoneFound: false,
  }), 'none (censored partial at k=2; benchDone.found=false)');
});

test('CLI: --deliverables with a 3-name list preflights without a paid run', (t) => {
  const root = scratchRoot('test-racoons-deliverables-cli-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const armDir = join(root, 'arm');
  const evidenceDir = join(root, 'evidence');
  mkdirSync(armDir, { recursive: true });
  const briefPath = join(root, 'brief.md');
  const listPath = join(root, 'deliverables.txt');
  const bin = join(root, 'stub-bin.cjs');
  writeFileSync(briefPath, ['# brief', '', '## Task text', '', '```text',
    'Write three records, then print BENCH-DONE.', '```', ''].join('\n'));
  writeFileSync(listPath, 'docs/plans/short/00-a.md\ndocs/plans/short/01-b.md\n'
    + 'docs/plans/short/02-c.md\n');
  writeFileSync(bin, [
    "const { readFileSync } = require('node:fs');",
    "if (!process.argv.includes('--dump-config')) process.stdout.write('0.0.0-stub\\n');",
    'else {',
    "  const at = process.argv.indexOf('--patch');",
    "  const patch = readFileSync(process.argv[at + 1], 'utf8');",
    '  for (const id of [' + JSON.stringify([
      'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-subagent-control',
      'tool-subagent-list-agents', 'subagent-spawn-in-process', 'subagent-fork-in-process',
      'workflow-ptc',
    ]).slice(1, -1) + ']) process.stdout.write(`- id: ${id}\\n  disabled: true\\n`);',
    "  const lines = patch.split(/\\r?\\n/u);",
    "  const prunerAt = lines.findIndex((line) => line.trim() === '- id: tool-result-pruner');",
    "  const prunerOff = prunerAt !== -1 && /^\\s+disabled: true\\s*(#.*)?$/u.test(lines[prunerAt + 1] ?? '');",
    "  process.stdout.write(`- id: tool-result-pruner\\n  disabled: ${prunerOff ? 'true' : 'false'}\\n`);",
    '}',
  ].join('\n'));
  const result = spawnSync(process.execPath, [LAUNCHER, '--preflight', '--arm', 'vanilla',
    '--provider', 'mock', '--arm-dir', armDir, '--dsh-bin', bin, '--evidence', evidenceDir,
    '--brief', briefPath, '--deliverables', listPath],
  { encoding: 'utf8', cwd: root, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PREFLIGHT PASS/u);
});

test('ISSUE-265: the manifest deliverables.count is compared with the brief list', () => {
  const paths = Array.from({ length: 72 }, (_, index) => `docs/plans/big/${String(index).padStart(2, '0')}.md`);
  assert.deepEqual(manifestDeliverablesGate({ manifest: { deliverables: { count: 72 } }, paths }),
    { ok: true, count: 72 });
  const mismatch = manifestDeliverablesGate({ manifest: { deliverables: { count: 48 } }, paths });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.detail, /48/u);
  assert.match(mismatch.detail, /72/u);
  // A malformed count is a manifest defect, not a silent pass.
  assert.equal(manifestDeliverablesGate({ manifest: { deliverables: { count: '72' } }, paths }).ok, false);
  // A manifest without the block is stated, never passed silently.
  const absent = manifestDeliverablesGate({ manifest: {}, paths });
  assert.equal(absent.ok, true);
  assert.match(absent.skipped, /no deliverables block/u);
});

test('ISSUE-265: a repeated deliverable path is refused, never silently deduped', () => {
  const brief = 'Deliverables:\na/01.md\nb/02.md\na/01.md\n';
  const resolved = resolveBenchDeliverables({ briefText: brief, taskText: brief });
  assert.equal(resolved.paths.length, 2, 'the parser still dedupes its output');
  assert.deepEqual(resolved.duplicates, ['a/01.md'], 'the repeat is named');
  // An explicit list keeps both entries; the duplicate helper names it.
  const explicit = resolveBenchDeliverables({
    briefText: '', deliverablesText: 'a/01.md\na/01.md\nb/02.md\n',
  });
  assert.deepEqual(duplicateDeliverables(explicit.paths), ['a/01.md']);
  assert.deepEqual(explicit.duplicates, ['a/01.md']);
  // A 72-name list with no repeats has no duplicate.
  const names = Array.from({ length: 72 }, (_, index) => `docs/plans/big/${index}.md`);
  const clean = resolveBenchDeliverables({ briefText: '', deliverablesText: `${names.join('\n')}\n` });
  assert.equal(clean.paths.length, 72);
  assert.deepEqual(clean.duplicates, []);
});

test('ISSUE-270: a completed real route needs BENCH-DONE; a stop does not', () => {
  const missing = benchDoneRequirement({ provider: 'deepseek-official' });
  assert.equal(missing.required, true);
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /no assistant message carried BENCH-DONE/u);
  assert.deepEqual(benchDoneRequirement({ provider: 'deepseek-official', doneFound: true }),
    { required: true, ok: true, detail: 'an assistant message carried BENCH-DONE' });
  // A stop is a censored partial and already not passed; the marker is not owed.
  assert.equal(benchDoneRequirement({ provider: 'deepseek-official', stopReason: 'budget' }).required, false);
  // The mock lanes keep the explicit flag.
  assert.equal(benchDoneRequirement({ provider: 'mock' }).required, false);
  assert.equal(benchDoneRequirement({ provider: 'mock', requireDone: true }).required, true);
  // The failed done row is an assertion failure, so the run-level label is not
  // a measurement.
  const label = runCitableAs({
    stopReason: null,
    citableAs: 'measurement (reasoning measured)',
    failures: [{ name: 'BENCH-DONE was declared' }],
  });
  assert.match(label, /^none \(1 assertion\(s\) failed/u);
});

test('ISSUE-260: the child env is an allow-list; provider keys do not survive', () => {
  const env = childEnvBase({
    PATH: 'C:\\Windows',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\xxxxx',
    DRIVERDATA: 'C:\\Windows\\System32\\Drivers\\DriverData',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '1',
    NO_COLOR: '1',
    OPENAI_API_KEY: 'sk-openai',
    ANTHROPIC_API_KEY: 'anthropic',
    AWS_SECRET_ACCESS_KEY: 'aws',
    GITHUB_TOKEN: 'ghp_x',
    DEEPSEEK_API_KEY: 'deepseek',
    BENCH_REAL_API: '1',
    RIG_CREDENTIALS_PATH: 'C:\\creds.yaml',
    UNRELATED: 'kept-out',
  });
  // The three home variables are this lane's own (the opencode lane drops them);
  // the three colour variables are the opencode lane's and never appear here.
  assert.deepEqual(env, {
    PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp',
    HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\xxxxx',
    DRIVERDATA: 'C:\\Windows\\System32\\Drivers\\DriverData',
  });
  assert.equal(Object.hasOwn(env, 'OPENAI_API_KEY'), false);
  assert.equal(Object.hasOwn(env, 'DEEPSEEK_API_KEY'), false);
  assert.equal(Object.hasOwn(env, 'BENCH_REAL_API'), false);
});

test('PYTHONUTF8 survives the child env, and the launched child pins it to 1', () => {
  const env = childEnvBase({ PATH: 'C:\\Windows', PYTHONUTF8: '1', OPENAI_API_KEY: 'sk-openai' });
  // The GBK-default host needs UTF-8 mode to read UTF-8 JSON in a python child.
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(Object.hasOwn(env, 'OPENAI_API_KEY'), false);
  const source = readFileSync(join(BENCH_DIR, 'bench-run.mjs'), 'utf8');
  assert.match(source, /Object\.assign\(childEnv, \{[^}]*PYTHONUTF8: '1'/u,
    'the launched dsh child sets PYTHONUTF8 even when the operator did not export it');
});

test('ISSUE-270: mock, taskkill and dsh discovery get the scrubbed env, not process.env', () => {
  const source = readFileSync(join(BENCH_DIR, 'bench-run.mjs'), 'utf8');
  // The sentinel is a credential shape and a non-allow-listed name: the
  // allow-list drops it by name alone (the value shape is not consulted).
  const sentinel = 'sk-sentinel-must-not-reach-a-helper';
  const scrubbed = childEnvBase({
    PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows',
    CREMATOR_TEST_SENTINEL: sentinel, OPENAI_API_KEY: sentinel,
  });
  assert.equal(Object.hasOwn(scrubbed, 'CREMATOR_TEST_SENTINEL'), false);
  assert.equal(Object.hasOwn(scrubbed, 'OPENAI_API_KEY'), false);
  assert.ok(!Object.values(scrubbed).includes(sentinel), 'no sentinel value survives the allow-list');
  // Every scratch helper is spawned with that env. The launched dsh child uses
  // the larger `childEnv`, which is built from the same allow-list.
  assert.match(source,
    /mock = spawn\(process\.execPath, \[[\s\S]*?\], \{ cwd: evidenceDir, windowsHide: true, env: childEnvBase\(\) \}\);/u,
    'the mock child gets the allow-listed env');
  assert.match(source, /spawn\('taskkill',[\s\S]*?env: childEnvBase\(\)/u,
    'taskkill gets the allow-listed env');
  assert.match(source,
    /spawnSync\(process\.platform === 'win32' \? 'npm\.cmd' : 'npm', \['root', '-g'\],[\s\S]*?env: childEnvBase\(\)/u,
    'npm root -g gets the allow-listed env');
  assert.match(source, /spawnSync\('where', \['dsh'\], \{[^}]*env: childEnvBase\(\)/u,
    'where dsh gets the allow-listed env');
  assert.doesNotMatch(source, /env:\s*process\.env/u, 'no child receives the parent environment');
});

test('ISSUE-260: a provider key in the task text is refused; the env NAME is not', () => {
  assert.match(taskKeyRefusal(`do the work with sk-${'a'.repeat(32)}`), /provider key shape/u);
  assert.match(taskKeyRefusal('DEEPSEEK_API_KEY=abcdef123456'), /provider key assignment/u);
  assert.match(taskKeyRefusal('token ghp_abcdefghijklmnopqrstuvwxyz0123456789'), /provider key shape/u);
  // The brief's own warning names the variable without a value; that is not a key.
  assert.equal(taskKeyRefusal('DEEPSEEK_API_KEY never exported; test -z "${DEEPSEEK_API_KEY:-}"'), null);
  assert.equal(taskKeyRefusal('Write the twelve records and print BENCH-DONE.'), null);
});

test('ISSUE-260: evidence must resolve under scratchpad and outside the arm/world', () => {
  assert.match(evidenceDirRefusal({ evidenceDir: join(tmpdir(), 'racoons-outside-evidence') }),
    /must live under/u);
  assert.match(evidenceDirRefusal({ evidenceDir: SCRATCHPAD }), /must live under/u);
  const base = join(SCRATCHPAD, 'test-evidence-containment', 'evidence');
  assert.equal(evidenceDirRefusal({ evidenceDir: base }), null);
  assert.match(evidenceDirRefusal({ evidenceDir: base, armDir: join(base, 'arm') }), /overlaps the arm/u);
  assert.match(evidenceDirRefusal({ evidenceDir: base, world: base }), /world root/u);
  assert.match(evidenceDirRefusal({ evidenceDir: base, world: join(SCRATCHPAD, 'other-world') }),
    /outside the world/u);
});

test('ISSUE-260: --allow-read refuses drive roots, repo, evidence, work copy and credentials', () => {
  const drive = process.platform === 'win32' ? 'C:\\' : '/';
  assert.match(allowReadRefusal({ root: drive }), /drive root/u);
  assert.match(allowReadRefusal({ root: REPO_ROOT }), /overlaps this repo/u);
  const base = join(tmpdir(), 'racoons-allow-read');
  assert.match(allowReadRefusal({ root: join(base, 'evidence'), evidenceDir: join(base, 'evidence') }),
    /overlaps the evidence dir/u);
  assert.match(allowReadRefusal({ root: join(base, 'work'), workDir: join(base, 'work') }),
    /overlaps the work copy/u);
  const home = join(tmpdir(), 'racoons-fake-home');
  assert.match(allowReadRefusal({ root: join(home, '.dsh'), home }), /credential store/u);
  assert.match(allowReadRefusal({ root: home, home }), /home directory/u);
  // A normal directory outside the repo and the home tree is allowed.
  assert.equal(allowReadRefusal({ root: join(tmpdir(), 'racoons-allowed-read'),
    evidenceDir: join(base, 'evidence'), workDir: join(base, 'work'), home }), null);
});

test('ISSUE-260: --allow-read refuses ~/.config and env-named credential stores', () => {
  const home = join(tmpdir(), 'racoons-fake-home');
  // `~/.config` holds gh, gcloud and pip credentials, and a path inside it is
  // not read material either.
  assert.match(allowReadRefusal({ root: join(home, '.config'), home }), /credential store/u);
  assert.match(allowReadRefusal({ root: join(home, '.config', 'gh', 'hosts.yml'), home }),
    /credential store/u);
  // The store a run itself names is refused too. `DSH_CREDENTIALS_PATH` and
  // `RIG_CREDENTIALS_PATH` are env-named paths, not fixed home names, so a
  // root equal to the store or containing it may not be allow-listed.
  const customStore = join(tmpdir(), 'racoons-custom-credential-store');
  const storeEnv = {
    DSH_CREDENTIALS_PATH: join(customStore, 'dsh', '.credentials.yaml'),
    RIG_CREDENTIALS_PATH: join(customStore, 'rig', 'credentials.yaml'),
  };
  assert.match(allowReadRefusal({ root: join(customStore, 'dsh', '.credentials.yaml'), home, env: storeEnv }),
    /credential store/u);
  assert.match(allowReadRefusal({ root: customStore, home, env: storeEnv }), /credential store/u);
  // A normal directory outside the repo, the home tree and the named stores is
  // allowed; the refusal is about the credential path, not every sibling tree.
  assert.equal(allowReadRefusal({ root: join(tmpdir(), 'racoons-allowed-read'),
    home, env: storeEnv }), null);
});

test('web preflight: the four rows closed pass; one enabled copy fails by name', () => {
  const closed = [
    { row: 'web-search-deepseek', disabled: true }, { row: 'web-deepseek-api', disabled: true },
    { row: 'web', disabled: true }, { row: 'tool-web', disabled: true },
  ];
  assert.deepEqual(preflightWebRequirement({ denyWeb: true, rows: closed }),
    { ok: true, checked: true, enabled: [], absent: [] });
  const open = closed.map((row) => (row.row === 'web' ? { ...row, disabled: false } : row));
  const failed = preflightWebRequirement({ denyWeb: true, rows: open });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.enabled, ['web']);
  assert.match(failed.detail, /--deny-web[\s\S]*web enabled/u);
  // A patched row can compose more than once; one enabled copy fails the gate.
  const doubled = [...closed, { row: 'web', disabled: false }];
  assert.equal(preflightWebRequirement({ denyWeb: true, rows: doubled }).ok, false,
    'any enabled copy of a web row fails');
});

test('web preflight: absent rows pass and are reported; the check is inert without the flag', () => {
  const absent = preflightWebRequirement({ denyWeb: true, rows: [] });
  assert.deepEqual(absent, {
    ok: true, checked: true, enabled: [], absent: ['web-search-deepseek', 'web-deepseek-api', 'web', 'tool-web'],
  });
  const inert = preflightWebRequirement({ denyWeb: false, rows: [{ row: 'web', disabled: false }] });
  assert.equal(inert.ok, true);
  assert.equal(inert.checked, false);
  assert.deepEqual(inert.enabled, ['web']);
});

test('workspace-only: an outside read becomes a violation, a campaign read stays one', () => {
  const report = {
    inside: 1,
    allowed: 0,
    violations: [{ tool: 'read', path: 'campaign/x', scope: 'campaign' }],
    outside: [{ tool: 'read', path: 'C:/Windows/x' }],
    gitChannel: [],
  };
  assert.equal(workspaceOnlyReport(report, false), report, 'the default rule is unchanged');
  const strict = workspaceOnlyReport(report, true);
  assert.equal(strict.outside.length, 0);
  assert.equal(strict.violations.length, 2);
  assert.equal(strict.violations[0].scope, 'campaign');
  assert.equal(strict.violations[1].scope, 'outside');
  assert.equal(strict.violations[1].path, 'C:/Windows/x');
});

test('workspace-only: TEMP, TMP and TMPDIR name an arm-local .tmp directory', () => {
  const arm = join(tmpdir(), 'racoons-arm-temp-env');
  assert.equal(workspaceTempSetup({ workDir: arm, workspaceOnly: false }), null,
    'a non-strict run creates nothing and keeps the inherited OS temp env');
  const setup = workspaceTempSetup({ workDir: arm, workspaceOnly: true });
  const expected = resolve(arm, '.tmp');
  assert.equal(setup.dir, expected);
  assert.deepEqual(setup.env, { TEMP: expected, TMP: expected, TMPDIR: expected });
  assert.equal(inside(arm, setup.dir), true, 'the temp root is inside the arm');
});

test('workspace-only: an arm-local temp read is inside; an OS-temp read still fails', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'racoons-workspace-temp-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const arm = join(base, 'racoons', 'arm');
  const evidence = join(base, 'racoons', 'evidence');
  mkdirSync(arm, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  const setup = workspaceTempSetup({ workDir: arm, workspaceOnly: true });
  mkdirSync(setup.dir, { recursive: true });
  const localTempFile = join(setup.dir, 't2-missing.txt');
  writeFileSync(localTempFile, 'row\n');
  // The failed 2026-11-08 shape: a literal OS-temp path named by the read.
  const osTempFile = join(tmpdir(), 'racoons-t2-allpaths.txt');
  const sessionEvents = [
    { type: 'tool/call', seq: 328,
      data: { name: 'read', callId: 'call_local',
        arguments: JSON.stringify({ file_path: localTempFile }) } },
    { type: 'tool/call', seq: 347,
      data: { name: 'read', callId: 'call_os',
        arguments: JSON.stringify({ file_path: osTempFile }) } },
  ];
  const input = {
    sessionEvents,
    workDir: arm,
    worldRoots: [arm, evidence],
    campaignRoot: campaignRootFor({ worldRoot: null, root: base, armDir: arm, evidenceDir: evidence }),
  };
  const report = classifyToolCalls({ ...input, scratch: [] });
  assert.equal(report.inside, 1, 'the arm-local temp file is inside the arm world');
  assert.equal(report.outside.length, 1, 'the OS-temp read is outside the campaign');
  assert.equal(report.violations.length, 0);
  assert.equal(report.outside[0].path, osTempFile);
  const strict = workspaceOnlyReport(report, true);
  assert.equal(strict.inside, 1);
  assert.equal(strict.outside.length, 0);
  assert.equal(strict.violations.length, 1, 'strict mode still refuses the OS temp path');
  assert.equal(strict.violations[0].scope, 'outside');
  assert.equal(strict.violations[0].path, osTempFile);
  // The OS temp allowance is unchanged when the strict flag is absent.
  const lenient = classifyToolCalls(input);
  assert.equal(lenient.inside, 1);
  assert.equal(lenient.allowed, 1);
  assert.equal(lenient.violations.length, 0);
});

test('read boundary: the 48-pilot seq-145 pwsh Test-Path on ../miliastra-game-template is one outside row', () => {
  // The 2026-11-12 48-record pilot, seq 145, replayed: one pwsh command that
  // tests whether the template path beside the arm exists. It names exactly
  // one path the scan judges, and detection (not prevention) is what this pins.
  const command = 'pwsh Test-Path ../miliastra-game-template/docs/project/platform/ref-measurements.md';
  const sessionEvents = [{ type: 'tool/call', seq: 145,
    data: { name: 'pwsh', callId: 'call_pilot_seq_145',
      arguments: JSON.stringify({ description: 'Check existence of cited docs directories', command }) } }];
  const armDir = join(tmpdir(), 'racoons-bench', '2026-10-23-aetherium', 'racoons-arm');
  const campaignRoot = join(tmpdir(), 'racoons-48-pilot', 'racoons-r1');
  const report = classifyToolCalls({ sessionEvents, workDir: armDir, worldRoots: [armDir],
    campaignRoot, scratch: [] });
  assert.equal(report.judged, 1, 'the Test-Path path is the only judged path');
  assert.equal(report.violations.length, 0, 'the lenient rule records the read instead of failing it');
  assert.equal(report.outside.length, 1, 'one outside row for the ../miliastra-game-template path');
  assert.equal(report.outside[0].seq, 145);
  assert.equal(report.outside[0].path,
    '../miliastra-game-template/docs/project/platform/ref-measurements.md');
  const strict = workspaceOnlyReport(report, true);
  assert.equal(strict.outside.length, 0);
  assert.equal(strict.violations.length, 1, 'workspace-only turns that outside row into a violation');
  assert.equal(strict.violations[0].seq, 145);
  assert.equal(strict.violations[0].scope, 'outside');
  assert.equal(inside(armDir, strict.violations[0].resolved), false, 'the path left the arm');
});

test('workspace-only: the spawned child receives TEMP, TMP and TMPDIR inside the work copy', () => {
  const root = scratchRoot('test-racoons-workspace-temp-child-');
  try {
    const armDir = join(root, 'arm');
    const evidenceDir = join(root, 'evidence');
    mkdirSync(armDir, { recursive: true });
    const bin = join(root, 'stub-env.cjs');
    // The child is a stub dsh: it records the environment the launcher actually
    // spawned it with. The mock lane requires --dry-work, so the child runs in
    // the work copy and the temp root must be inside that copy.
    writeFileSync(bin,
      "require('node:fs').writeFileSync('.child-env.json', JSON.stringify(process.env));\n");
    spawnSync(process.execPath, [LAUNCHER, '--arm', 'vanilla', '--provider', 'mock',
      '--dry-work', '--workspace-only', '--arm-dir', armDir, '--dsh-bin', bin,
      '--evidence', evidenceDir], { encoding: 'utf8', cwd: root, windowsHide: true, timeout: 60_000 });
    const workDir = join(evidenceDir, 'work');
    const childEnv = JSON.parse(readFileSync(join(workDir, '.child-env.json'), 'utf8'));
    const expected = resolve(workDir, '.tmp');
    assert.equal(childEnv.TEMP, expected);
    assert.equal(childEnv.TMP, expected);
    assert.equal(childEnv.TMPDIR, expected);
    assert.equal(inside(workDir, expected), true, 'the child temp root is inside the work copy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace-only: launch.json records the temp dir and the three env values', () => {
  const root = scratchRoot('test-racoons-workspace-temp-record-');
  try {
    const armDir = join(root, 'arm');
    const evidenceDir = join(root, 'evidence');
    mkdirSync(armDir, { recursive: true });
    const bin = join(root, 'stub-bin.cjs');
    const stub = [
      "const { readFileSync } = require('node:fs');",
      `const rows = ${JSON.stringify([
        'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-subagent-control',
        'tool-subagent-list-agents', 'subagent-spawn-in-process', 'subagent-fork-in-process', 'workflow-ptc',
      ])};`,
      "if (!process.argv.includes('--dump-config')) process.stdout.write('0.0.0-stub\\n');",
      'else {',
      "  const at = process.argv.indexOf('--patch');",
      "  const patch = readFileSync(process.argv[at + 1], 'utf8');",
      '  for (const id of rows) process.stdout.write(`- id: ${id}\\n  disabled: true\\n`);',
      '  const lines = patch.split(/\\r?\\n/u);',
      "  const prunerAt = lines.findIndex((line) => line.trim() === '- id: tool-result-pruner');",
      "  const prunerOff = prunerAt !== -1 && /^\\s+disabled: true\\s*(#.*)?$/u.test(lines[prunerAt + 1] ?? '');",
      "  process.stdout.write(`- id: tool-result-pruner\\n  disabled: ${prunerOff ? 'true' : 'false'}\\n`);",
      '}',
    ].join('\n');
    writeFileSync(bin, stub);
    const result = spawnSync(process.execPath, [LAUNCHER, '--preflight', '--arm', 'vanilla',
      '--provider', 'mock', '--workspace-only', '--arm-dir', armDir, '--dsh-bin', bin,
      '--evidence', evidenceDir], { encoding: 'utf8', cwd: root, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PREFLIGHT PASS/u);
    const record = JSON.parse(readFileSync(join(evidenceDir, 'launch.json'), 'utf8'));
    const expected = resolve(armDir, '.tmp');
    assert.equal(record.readBoundary.workspaceOnly, true);
    assert.equal(record.readBoundary.tempDir, expected);
    assert.deepEqual(record.readBoundary.tempEnv,
      { TEMP: expected, TMP: expected, TMPDIR: expected });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ISSUE-297: --workspace-only accepts --allow-tool-root and records both', (t) => {
  const root = scratchRoot('test-racoons-tool-root-record-');
  const toolRoot = mkdtempSync(join(tmpdir(), 'racoons-tool-root-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(toolRoot, { recursive: true, force: true });
  });
  const armDir = join(root, 'arm');
  const evidenceDir = join(root, 'evidence');
  mkdirSync(armDir, { recursive: true });
  const bin = join(root, 'stub-bin.cjs');
  const stub = [
    "const { readFileSync } = require('node:fs');",
    `const rows = ${JSON.stringify([
      'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-subagent-control',
      'tool-subagent-list-agents', 'subagent-spawn-in-process', 'subagent-fork-in-process', 'workflow-ptc',
    ])};`,
    "if (!process.argv.includes('--dump-config')) process.stdout.write('0.0.0-stub\\n');",
    'else {',
    "  const at = process.argv.indexOf('--patch');",
    "  const patch = readFileSync(process.argv[at + 1], 'utf8');",
    '  for (const id of rows) process.stdout.write(`- id: ${id}\\n  disabled: true\\n`);',
    '  const lines = patch.split(/\\r?\\n/u);',
    "  const prunerAt = lines.findIndex((line) => line.trim() === '- id: tool-result-pruner');",
    "  const prunerOff = prunerAt !== -1 && /^\\s+disabled: true\\s*(#.*)?$/u.test(lines[prunerAt + 1] ?? '');",
    "  process.stdout.write(`- id: tool-result-pruner\\n  disabled: ${prunerOff ? 'true' : 'false'}\\n`);",
    '}',
  ].join('\n');
  writeFileSync(bin, stub);
  const result = spawnSync(process.execPath, [LAUNCHER, '--preflight', '--arm', 'vanilla',
    '--provider', 'mock', '--workspace-only', '--allow-tool-root', toolRoot,
    '--arm-dir', armDir, '--dsh-bin', bin, '--evidence', evidenceDir,
  ], { encoding: 'utf8', cwd: root, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PREFLIGHT PASS/u);
  const record = JSON.parse(readFileSync(join(evidenceDir, 'launch.json'), 'utf8'));
  assert.equal(record.readBoundary.workspaceOnly, true);
  assert.deepEqual(record.readBoundary.allowRead, []);
  assert.deepEqual(record.readBoundary.allowToolRoots, [resolve(toolRoot)]);
});

test('ISSUE-297: --workspace-only --allow-read stays refused; a tool root follows the allow-read rules', (t) => {
  const root = scratchRoot('test-racoons-tool-root-refusals-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const armDir = join(root, 'arm');
  const evidenceDir = join(root, 'evidence');
  mkdirSync(armDir, { recursive: true });
  const combine = spawnSync(process.execPath, [LAUNCHER, '--arm', 'vanilla', '--provider', 'mock',
    '--workspace-only', '--allow-read', join(root, 'read-root'),
  ], { encoding: 'utf8', cwd: root, windowsHide: true });
  assert.equal(combine.status, 2, combine.stderr);
  assert.match(combine.stderr,
    /--workspace-only cannot be combined with --allow-read \(workspace-only means the arm world is the only readable root\)/u);
  const drive = process.platform === 'win32' ? 'C:\\' : '/';
  for (const [toolRoot, pattern] of [
    [drive, /drive root/u],
    [REPO_ROOT, /overlaps this repo/u],
    // A tool root INSIDE the evidence dir is refused. The evidence dir lives
    // under this repo, so the repo rule fires first; the root is refused anyway.
    [join(evidenceDir, 'nested'), /overlaps this repo|overlaps the evidence dir/u],
  ]) {
    const result = spawnSync(process.execPath, [LAUNCHER, '--preflight', '--arm', 'vanilla',
      '--provider', 'mock', '--allow-tool-root', toolRoot,
      '--arm-dir', armDir, '--evidence', evidenceDir,
    ], { encoding: 'utf8', cwd: root, windowsHide: true });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--allow-tool-root/u);
    assert.match(result.stderr, pattern);
  }
});

test('ISSUE-297: a tool root makes the venv interpreter allowed, every other outside path still fails', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'racoons-tool-root-classify-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const world = join(base, 'world');
  const arm = join(world, 'arm');
  mkdirSync(arm, { recursive: true });
  const toolRoot = join(base, 'venvs', 'task-1', 'venv');
  const python = join(toolRoot, 'Scripts', 'python.exe');
  const outsideFile = join(base, 'task-pack.json');
  const sessionEvents = [
    { type: 'tool/call', seq: 11,
      data: { name: 'pwsh', callId: 'call_venv',
        arguments: JSON.stringify({ command: `& "${python}" -m pytest -q` }) } },
    { type: 'tool/call', seq: 12,
      data: { name: 'read', callId: 'call_pack',
        arguments: JSON.stringify({ file_path: outsideFile }) } },
  ];
  const input = {
    sessionEvents,
    workDir: arm,
    worldRoots: [world],
    campaignRoot: join(base, 'campaign'),
    scratch: [],
  };
  const report = classifyToolCalls({ ...input, allow: [toolRoot] });
  assert.equal(report.allowed, 1, 'the venv interpreter under the tool root is allowed');
  assert.equal(report.outside.length, 1, 'a path outside the world and the tool root is outside');
  assert.equal(report.outside[0].seq, 12);
  assert.equal(report.violations.length, 0);
  const strict = workspaceOnlyReport(report, true);
  assert.equal(strict.allowed, 1, 'the tool root stays reachable under workspace-only');
  assert.equal(strict.outside.length, 0);
  assert.equal(strict.violations.length, 1, 'every other outside path becomes a violation');
  assert.equal(strict.violations[0].seq, 12);
  assert.equal(strict.violations[0].scope, 'outside');
});

test('policy watchdog: a checkpoint file fires once, records the stop, and a halt is final', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-policy-watch-'));
  try {
    const file = join(root, 'checkpoint.md');
    let compactions = 0;
    let billed = 12345;
    const watch = {
      poll: () => ({ billedPromptTokens: billed }),
      get compactions() { return compactions; },
    };
    let killed = 0;
    const watchdog = createPolicyWatchdog({
      checkpointPath: 'docs/checkpoint.md',
      checkpointFile: file,
      watch,
      pollMs: 1_000_000,
      onCheckpoint: () => { killed += 1; return true; },
      now: () => 1_700_000_000_000,
    });
    assert.equal(watchdog.state.checkpointFired, false);
    watchdog.pollOnce();
    assert.equal(watchdog.state.checkpointFired, false, 'an absent file does not fire');
    assert.equal(watchdog.state.polls, 1);
    writeFileSync(file, '# created\n');
    billed = 23456;
    watchdog.pollOnce();
    assert.equal(watchdog.state.checkpointFired, true);
    assert.equal(killed, 1);
    assert.equal(watchdog.state.checkpointStoppedAt.path, 'docs/checkpoint.md');
    assert.equal(watchdog.state.checkpointStoppedAt.resolved, file);
    assert.equal(watchdog.state.checkpointStoppedAt.billedPromptTokens, 23456);
    assert.equal(watchdog.state.checkpointStoppedAt.killLanded, true);
    assert.deepEqual(watchdog.state.checkpointStoppedAt.firedAt, '2023-11-14T22:13:20.000Z');
    // A halted watchdog never fires again, including on the launcher's final read.
    watchdog.pollOnce();
    assert.equal(killed, 1);
    assert.equal(watchdog.state.checkpointStoppedAt.billedPromptTokens, 23456);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('policy watchdog: a checkpoint fires only when its contiguous prefix exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-policy-prefix-'));
  try {
    const names = ['00-index.md', '01-orientation.md', '02-entry-currency.md', '03-core-charter.md'];
    const files = names.map((name) => join(root, 'docs', 'plans', 'p', name));
    mkdirSync(join(root, 'docs', 'plans', 'p'), { recursive: true });
    const paths = names.map((name) => `docs/plans/p/${name}`);
    // The launcher turns the measured list into the absolute prefix before the
    // target; the helper is the one checked here.
    const prerequisites = checkpointPrerequisiteFiles({
      paths,
      workDir: root,
      checkpointFile: files[3],
    });
    assert.deepEqual(prerequisites, files.slice(0, 3));

    const watch = { poll: () => ({ billedPromptTokens: 1000 }), compactions: 0 };
    let killed = 0;
    const watchdog = createPolicyWatchdog({
      checkpointPath: paths[3],
      checkpointFile: files[3],
      checkpointPrerequisites: prerequisites,
      watch,
      pollMs: 1_000_000,
      onCheckpoint: () => { killed += 1; return true; },
    });
    // Only 03 exists: the target appeared but 00-02 do not, so it must not fire.
    writeFileSync(files[3], 'target only\n');
    watchdog.pollOnce();
    assert.equal(watchdog.state.checkpointFired, false, 'only 03 exists; 00-02 are missing');
    assert.equal(killed, 0);
    assert.deepEqual(watchdog.state.checkpointMissingPrerequisites, files.slice(0, 3));

    // Add 00 and 01: 02 is still missing, so the prefix is still broken.
    writeFileSync(files[0], '0\n');
    writeFileSync(files[1], '1\n');
    watchdog.pollOnce();
    assert.equal(watchdog.state.checkpointFired, false, '02 is still missing');
    assert.equal(killed, 0);

    // Add 02: 00,01,02,03 all exist and the stop fires once.
    writeFileSync(files[2], '2\n');
    watchdog.pollOnce();
    assert.equal(watchdog.state.checkpointFired, true);
    assert.equal(killed, 1);
    assert.equal(watchdog.state.checkpointStoppedAt.resolved, files[3]);
    watchdog.finalPoll();
    assert.equal(killed, 1, 'the stop stays one-way');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('policy watchdog: the compaction limit fires at the Nth count, not before', () => {
  let compactions = 1;
  let killed = 0;
  const watch = { poll: () => ({ billedPromptTokens: 1000 }), get compactions() { return compactions; } };
  const watchdog = createPolicyWatchdog({
    stopAfterCompactions: 2,
    watch,
    pollMs: 1_000_000,
    onCompactionLimit: () => { killed += 1; return false; },
  });
  watchdog.pollOnce();
  assert.equal(watchdog.state.compactionLimitFired, false);
  compactions = 2;
  watchdog.pollOnce();
  assert.equal(watchdog.state.compactionLimitFired, true);
  assert.equal(killed, 1);
  assert.equal(watchdog.state.compactionLimitStoppedAt.limit, 2);
  assert.equal(watchdog.state.compactionLimitStoppedAt.observed, 2);
  assert.equal(watchdog.state.compactionLimitStoppedAt.killLanded, false,
    'a child that already ended is not reported as killed');
  compactions = 3;
  watchdog.finalPoll();
  assert.equal(killed, 1, 'the stop is one-way');
});

test('policy watchdog: no flag is inert', () => {
  let polls = 0;
  const watchdog = createPolicyWatchdog({
    watch: { poll: () => { polls += 1; return { billedPromptTokens: 0 }; }, compactions: 0 },
    pollMs: 1_000_000,
  });
  watchdog.start();
  watchdog.pollOnce();
  watchdog.stop();
  assert.equal(polls, 0, 'an unarmed watchdog reads no file');
  assert.equal(watchdog.state.checkpoint, null);
  assert.equal(watchdog.state.stopAfterCompactions, null);
});

test('ISSUE-260: --evidence outside scratchpad exits 2 and deletes nothing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-evidence-outside-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const armDir = join(root, 'arm');
  const evidenceDir = join(root, 'evidence');
  mkdirSync(armDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  const sentinel = join(evidenceDir, 'keep.txt');
  writeFileSync(sentinel, 'this must survive the refusal\n');
  const result = spawnSync(process.execPath, [LAUNCHER, '--preflight', '--arm', 'vanilla',
    '--provider', 'mock', '--arm-dir', armDir, '--evidence', evidenceDir,
  ], { encoding: 'utf8', cwd: root, windowsHide: true });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /must live under .*scratchpad/u);
  assert.equal(readFileSync(sentinel, 'utf8'), 'this must survive the refusal\n');
  assert.equal(existsSync(join(evidenceDir, 'launch.json')), false, 'nothing was written first');
});

test('ISSUE-265: a manifest deliverables.count mismatch exits 2 before the wipe', (t) => {
  const root = scratchRoot('test-racoons-manifest-count-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const armDir = join(root, 'arm');
  const evidenceDir = join(root, 'evidence');
  mkdirSync(armDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  const sentinel = join(evidenceDir, 'keep.txt');
  writeFileSync(sentinel, 'the previous round\n');
  const manifest = join(root, 'round.manifest.json');
  writeFileSync(manifest, `${JSON.stringify({ deliverables: { count: 48 } })}\n`);
  const result = spawnSync(process.execPath, [LAUNCHER, '--preflight', '--arm', 'vanilla',
    '--provider', 'mock', '--arm-dir', armDir, '--evidence', evidenceDir, '--manifest', manifest,
  ], { encoding: 'utf8', cwd: root, windowsHide: true });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /deliverables\.count is 48/u);
  assert.equal(readFileSync(sentinel, 'utf8'), 'the previous round\n');
});

test('ISSUE-265: a duplicate deliverable in --deliverables is refused by name', (t) => {
  const root = scratchRoot('test-racoons-duplicate-deliverables-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const armDir = join(root, 'arm');
  const evidenceDir = join(root, 'evidence');
  mkdirSync(armDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  const sentinel = join(evidenceDir, 'keep.txt');
  writeFileSync(sentinel, 'kept\n');
  const list = join(root, 'deliverables.txt');
  writeFileSync(list, 'docs/plans/dup/00.md\ndocs/plans/dup/01.md\ndocs/plans/dup/00.md\n');
  const result = spawnSync(process.execPath, [LAUNCHER, '--preflight', '--arm', 'vanilla',
    '--provider', 'mock', '--arm-dir', armDir, '--evidence', evidenceDir, '--deliverables', list,
  ], { encoding: 'utf8', cwd: root, windowsHide: true });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /repeats \["docs\/plans\/dup\/00\.md"\]/u);
  assert.equal(readFileSync(sentinel, 'utf8'), 'kept\n');
});

test('ISSUE-260: a provider key in the brief task exits 2 before the wipe', (t) => {
  const root = scratchRoot('test-racoons-task-key-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const armDir = join(root, 'arm');
  const evidenceDir = join(root, 'evidence');
  mkdirSync(armDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  const sentinel = join(evidenceDir, 'keep.txt');
  writeFileSync(sentinel, 'the previous round\n');
  const brief = join(root, 'brief.md');
  writeFileSync(brief, ['# brief', '', '## Task text', '', '```text',
    `Use sk-${'a'.repeat(32)} to finish the task.`, '```', ''].join('\n'));
  const result = spawnSync(process.execPath, [LAUNCHER, '--preflight', '--arm', 'vanilla',
    '--provider', 'mock', '--arm-dir', armDir, '--evidence', evidenceDir, '--brief', brief,
  ], { encoding: 'utf8', cwd: root, windowsHide: true });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /provider key shape/u);
  assert.equal(readFileSync(sentinel, 'utf8'), 'the previous round\n');
});

test('ISSUE-270: --preflight leaves an existing non-empty evidence dir byte-identical', (t) => {
  const root = scratchRoot('test-racoons-preflight-preserve-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const armDir = join(root, 'arm');
  const evidenceDir = join(root, 'evidence');
  mkdirSync(armDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, 'keep.txt'), 'round one\n');
  writeFileSync(join(evidenceDir, 'patch.yml'), 'the prior patch\n');
  const bin = join(root, 'stub-bin.cjs');
  writeFileSync(bin, [
    "if (process.argv.includes('--version')) { process.stdout.write('0.0.0-stub\\n'); process.exit(0); }",
    "if (process.argv.includes('--dump-config')) {",
    "  process.stdout.write('- id: tool-result-pruner\\n  disabled: false\\n');",
    '  process.exit(0);',
    '}',
    'process.exit(0);',
  ].join('\n'));
  const result = spawnSync(process.execPath, [LAUNCHER, '--preflight', '--arm', 'vanilla',
    '--provider', 'mock', '--arm-dir', armDir, '--dsh-bin', bin, '--evidence', evidenceDir,
  ], { encoding: 'utf8', cwd: root, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PREFLIGHT PASS/u);
  assert.equal(readFileSync(join(evidenceDir, 'keep.txt'), 'utf8'), 'round one\n');
  assert.equal(readFileSync(join(evidenceDir, 'patch.yml'), 'utf8'), 'the prior patch\n');
  assert.equal(existsSync(join(evidenceDir, 'preflight', 'patch.yml')), true,
    'the preflight wrote into its own subdirectory');
});

test('ISSUE-265/260: a >30k brief and a 72-name list launch on stdin, with a scrubbed env', (t) => {
  const root = scratchRoot('test-racoons-large-task-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const armDir = join(root, 'arm');
  const evidenceDir = join(root, 'evidence');
  mkdirSync(armDir, { recursive: true });
  writeFileSync(join(armDir, 'AGENTS.md'), '# arm\n');
  const bin = join(root, 'stub-bin.cjs');
  writeFileSync(bin, [
    "const { writeFileSync } = require('node:fs');",
    "if (process.argv.includes('--version')) { process.stdout.write('0.0.0-stub\\n'); process.exit(0); }",
    "if (process.argv.includes('--dump-config')) { process.exit(0); }",
    "let task = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { task += chunk; });",
    "process.stdin.on('end', () => {",
    "  writeFileSync('.child-argv.json', JSON.stringify(process.argv.slice(2)));",
    "  writeFileSync('.child-task.txt', task);",
    "  writeFileSync('.child-env.json', JSON.stringify(process.env));",
    '  process.exit(0);',
    '});',
  ].join('\n'));
  const names = Array.from({ length: 72 }, (_, index) => `docs/plans/big/${String(index).padStart(2, '0')}.md`);
  const task = `${'A'.repeat(31_000)}\n\nDeliverables:\n${names.join('\n')}\n`;
  const brief = join(root, 'brief.md');
  writeFileSync(brief, ['# big brief', '', '## Task text', '', '```text', task, '```', ''].join('\n'));
  const env = {
    ...process.env,
    OPENAI_API_KEY: 'sk-openai-test',
    ANTHROPIC_API_KEY: 'anthropic-test',
    AWS_SECRET_ACCESS_KEY: 'aws-test',
    GITHUB_TOKEN: 'ghp-test',
  };
  const result = spawnSync(process.execPath, [LAUNCHER, '--arm', 'vanilla', '--provider', 'mock',
    '--dry-work', '--arm-dir', armDir, '--dsh-bin', bin, '--evidence', evidenceDir, '--brief', brief,
  ], { encoding: 'utf8', cwd: root, windowsHide: true, timeout: 120_000, env });
  assert.equal(result.error, undefined, result.error?.message);
  const workDir = join(evidenceDir, 'work');
  const childTask = readFileSync(join(workDir, '.child-task.txt'), 'utf8');
  assert.equal(childTask, task.trim(), 'the exact trimmed task travels on stdin');
  const childArgv = readFileSync(join(workDir, '.child-argv.json'), { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(childArgv).at(-1), '-');
  const childEnv = JSON.parse(readFileSync(join(workDir, '.child-env.json'), 'utf8'));
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN']) {
    assert.equal(Object.hasOwn(childEnv, name), false, `${name} must not reach the child`);
  }
  assert.equal(Object.hasOwn(childEnv, 'PATH') || Object.hasOwn(childEnv, 'Path'), true,
    'the platform PATH still reaches the child');
  const record = JSON.parse(readFileSync(join(evidenceDir, 'result.json'), 'utf8'));
  assert.equal(record.checkpoints.paths.length, 72);
  assert.equal(record.checkpoints.source, 'brief');
  assert.equal(record.brief.taskChars, task.trim().length);
});

test('ISSUE-260 W1: the child receives the route key and no other key (launch)', () => {
  const root = scratchRoot('test-racoons-w1-child-key-');
  try {
    const armDir = join(root, 'arm');
    const evidenceDir = join(root, 'evidence');
    mkdirSync(armDir, { recursive: true });
    const bin = join(root, 'stub-env.cjs');
    // The child is a stub dsh: it records the environment the launcher actually
    // spawned it with, before the mock lane runs its checks.
    writeFileSync(bin,
      "require('node:fs').writeFileSync('.child-env.json', JSON.stringify(process.env));\n");
    const sentinel = 'sk-parent-key-must-not-survive';
    spawnSync(process.execPath, [LAUNCHER, '--arm', 'vanilla', '--provider', 'mock',
      '--dry-work', '--arm-dir', armDir, '--dsh-bin', bin, '--evidence', evidenceDir], {
      encoding: 'utf8', cwd: root, windowsHide: true, timeout: 60_000,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: sentinel,
        OPENAI_API_KEY: 'sk-openai-parent',
        ANTHROPIC_API_KEY: 'anthropic-parent',
        AWS_SECRET_ACCESS_KEY: 'aws-parent',
        GITHUB_TOKEN: 'ghp_parent',
      },
    });
    const childEnv = JSON.parse(readFileSync(join(evidenceDir, 'work', '.child-env.json'), 'utf8'));
    // The only credential-shaped name that reaches the child is the mock lane's
    // dummy route key; the parent's key and every other provider key were
    // dropped before the first child started.
    const keyShaped = Object.keys(childEnv)
      .filter((name) => /(?:API_KEY|_KEY|TOKEN|SECRET|CREDENTIAL)/u.test(name.toUpperCase()))
      .sort();
    assert.deepEqual(keyShaped, ['DEEPSEEK_API_KEY']);
    assert.equal(childEnv.DEEPSEEK_API_KEY, 'mock-key-not-real');
    assert.notEqual(childEnv.DEEPSEEK_API_KEY, sentinel, 'the parent key did not survive');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
