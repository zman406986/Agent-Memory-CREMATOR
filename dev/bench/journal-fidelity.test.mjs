#!/usr/bin/env node
/**
 * The two journal gates that replaced the cap-count gate (ISSUE-089).
 *
 * ADR-0014 scrapped cap materialization: the core renderer refuses a `cap`
 * operation (`packages/core/src/guard/candidate.ts`), so `capArchives` is 0 on
 * every artifact and the old gate compared a planned cap count against
 * `replace` surface ops that were three OTHER lanes (the keep-all rewind, the
 * answered-entry forget and the prune checkpoint-revert). A live-route run
 * would have failed it on 0 vs N.
 *
 * What is held here:
 *
 *   (a) `fidelity: no cap archives exist (ADR-0014)` — the invariant, and its
 *       red: one `cap` archive on a `publish` line fails by name;
 *   (b) `fidelity: the <arm> arm's tool/result replacements match the applied
 *       removals` — an equality between the host's session log and the mount's
 *       journal, each `tool/result` replace being exactly one applied prune
 *       removal, one applied manual forget, one landed entry shape, one
 *       at-rest proof removal (counted from the application telemetry's
 *       `recallIds`, 2 in the 2026-11-08 rerun), or one host pruner trim;
 *   (c) the keep-all rewind's `user/message` replaces are excluded, and the
 *       artifacts below show why they must be: the keep-all run has one and no
 *       removal anywhere;
 *   (d) the red shapes: a replace with no lane behind it, a lane with no
 *       replace, a `not-applied` line that must not be counted, and the vanilla
 *       arm where the host pruner is the only lane;
 *   (e) `bench-run.mjs` names both gates and no longer carries the old name;
 *   (f) the host pruner's trims are a lane whenever the composed config leaves
 *       it mounted — unpadded runs included (ISSUE-101).
 *
 * `bench-run.mjs` runs `main()` only when invoked directly (`invokedDirectly`);
 * the predicates are extracted into `journal-fidelity.mjs` and (e) is static,
 * as `dist-hash.test.mjs` does for its own mount field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CAP_ARCHIVE_GATE,
  hostPrunerTrims,
  journalLanes,
  capArchiveGate,
  replacementAccounting,
  replacementGateName,
  removalLedgerGate,
} from './journal-fidelity.mjs';

const SOURCE = readFileSync(fileURLToPath(new URL('./bench-run.mjs', import.meta.url)), 'utf8');

/** One `replace` surface op, the shape the session log writes. */
function replace(type) {
  return { type, seq: 1, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1] };
}

/** The journal lines the three recorded artifacts actually carry, in their shape. */
const PRUNE_APPLIED = { kind: 'prune-apply', round: 2, removals: 1, status: 'applied' };
const ENTRY_LANDED = { kind: 'entry-apply', status: 'landed', action: 'forgetall', appends: 2 };
const ENTRY_REWOUND = { kind: 'entry-apply', status: 'rewound', action: 'keepall', appends: 1 };
const FORGET_APPLIED = { kind: 'forget', status: 'applied', unitId: 'unit:sha256:x' };
/**
 * The at-rest proof lane, in the shape the 2026-11-08 rerun's journal carries:
 * the pass writes `at-rest status=applied` with the intent, and the removals it
 * spliced are stated only on the matching `application` telemetry. Two ids, so
 * a "+1 per pass" count would read 1 and fail the ledger by one row.
 */
const AT_REST_INTENT =
  'intent:sha256:be86f52271313f33f5af804a4b1647382472cae04d799b094ceba16c554647cc';
const AT_REST_RECALL_IDS = [
  'recall:sha256:95877a6effb0d2f0587c93f03fb54503e0cb75f4aebf4344326a54ecf0f04eb2',
  'recall:sha256:5a9b5fbf8b445525d6b4febf4f3f254a5fdc104eaa58d0eeb70b0afba8d58787',
];
const AT_REST_APPLIED = { kind: 'at-rest', reason: 'step', status: 'applied',
  intentId: AT_REST_INTENT, issues: [] };
const AT_REST_APPLICATION = { kind: 'telemetry', event: { kind: 'application',
  intentId: AT_REST_INTENT, outcome: 'applied', recallIds: AT_REST_RECALL_IDS } };

test('089 (a) the zero-caps invariant is green on every recorded artifact shape', () => {
  // 2026-10-27-prune-apply-auto and -keepall-final: no publish line at all.
  assert.equal(capArchiveGate({ capArchives: 0 }).ok, true);
  assert.equal(capArchiveGate({ capArchives: 0 }).ok, true);
  assert.equal(CAP_ARCHIVE_GATE, 'fidelity: no cap archives exist (ADR-0014)');
});

test('089 (a) one cap archive fails by name: the ADR-0014 invariant, not a count', () => {
  // This is the shape `--perturb-journal-caps 1` produces in memory.
  const red = capArchiveGate({ capArchives: 1 });
  assert.equal(red.ok, false);
  assert.match(red.detail, /ADR-0014/u);
  assert.match(red.detail, /1 cap archive/u);
});

test('089 (b) the lanes are read from the lines the mount writes', () => {
  assert.deepEqual(journalLanes([PRUNE_APPLIED, ENTRY_REWOUND]), {
    appliedRemovals: 1, landedEntries: 0, appliedForgets: 0, rewinds: 1,
  });
  assert.deepEqual(journalLanes([ENTRY_LANDED, FORGET_APPLIED]), {
    appliedRemovals: 0, landedEntries: 1, appliedForgets: 1, rewinds: 0,
  });
  // A `not-applied` prune and a refused entry wrote nothing to the surface.
  assert.deepEqual(journalLanes([
    { kind: 'prune-apply', removals: 2, status: 'not-applied' },
    { kind: 'entry-apply', status: 'fail-open', action: 'forgetall' },
  ]), { appliedRemovals: 0, landedEntries: 0, appliedForgets: 0, rewinds: 0 });
});

test('the at-rest proof lane counts the application recallIds, not the pass', () => {
  assert.deepEqual(journalLanes([AT_REST_APPLIED, AT_REST_APPLICATION]), {
    appliedRemovals: 2, landedEntries: 0, appliedForgets: 0, rewinds: 0,
  });
  // Order-independent: the rerun's application telemetry is written just BEFORE
  // the at-rest line it answers, so the applied intent set is read in pass one.
  assert.deepEqual(journalLanes([AT_REST_APPLICATION, AT_REST_APPLIED]), {
    appliedRemovals: 2, landedEntries: 0, appliedForgets: 0, rewinds: 0,
  });
  // The intent set is the guard against double counting: an application line
  // with no applied at-rest line is the prune lane's subject, never this one.
  assert.equal(journalLanes([AT_REST_APPLICATION]).appliedRemovals, 0);
  assert.equal(journalLanes([{ ...AT_REST_APPLIED, status: 'unchanged' },
    AT_REST_APPLICATION]).appliedRemovals, 0);
  // The two proof removals are two tool/result replaces: the replacement gate
  // sees them, and the row is a measured equality, not a not-applicable pass.
  const gate = replacementAccounting({ arm: 'racoons', hostPruned: 0,
    sessionEvents: [replace('tool/result'), replace('tool/result')],
    journal: { lines: 2014, ...journalLanes([AT_REST_APPLIED, AT_REST_APPLICATION]) } });
  assert.equal(gate.ok, true);
  assert.equal(gate.class, 'measured');
  assert.equal(gate.applied, 2);
});

test('the 2026-11-08 rerun: 279 prune + 2 proof removals == 281 ledger rows', () => {
  const lanes = journalLanes([
    { kind: 'prune-apply', removals: 279, status: 'applied' },
    AT_REST_APPLIED, AT_REST_APPLICATION,
  ]);
  assert.equal(lanes.appliedRemovals, 281);
  // The ledger's applied-removal rows: verdict 279 + proof 2.
  const ledger = { total: 281, recallIds: AT_REST_RECALL_IDS };
  const ledgerGate = removalLedgerGate({ journal: lanes, applied: ledger,
    ledgerRecallIds: AT_REST_RECALL_IDS });
  assert.equal(ledgerGate.ok, true);
  assert.equal(ledgerGate.class, 'measured');
  assert.equal(ledgerGate.journalApplied, 281);
  assert.equal(ledgerGate.ledgerApplied, 281);
  // The same 281 on the replacement side: 281 tool/result replaces.
  const replacementGate = replacementAccounting({ arm: 'racoons', hostPruned: 0,
    sessionEvents: Array.from({ length: 281 }, () => replace('tool/result')),
    journal: { lines: 2014, ...lanes } });
  assert.equal(replacementGate.ok, true);
  assert.equal(replacementGate.applied, 281);
  // The pre-fix count stays red: the proof removals are in the ledger, not in
  // a journal that counted only prune-apply lines.
  const short = removalLedgerGate({
    journal: journalLanes([{ kind: 'prune-apply', removals: 279, status: 'applied' }]),
    applied: ledger, ledgerRecallIds: AT_REST_RECALL_IDS });
  assert.equal(short.ok, false);
  assert.match(short.detail, /journal records 279 applied removal\(s\); the ledger holds 281/u);
});

test('089 (c) prune-apply-auto: 1 tool/result replace == 1 applied removal', () => {
  const gate = replacementAccounting({ arm: 'racoons', hostPruned: 0,
    sessionEvents: [replace('tool/result')], journal: { lines: 80, ...journalLanes([PRUNE_APPLIED]) } });
  assert.equal(gate.ok, true);
});

test('089 (c) keepall-final: one user/message rewind replace, zero tool/result replaces', () => {
  // The line that would have kept the old gate red forever: a replace exists,
  // and no removal does. It is the exchange rewind's splice, not a removal.
  const events = [replace('user/message'), replace('user/message'), replace('user/message')];
  const gate = replacementAccounting({ arm: 'racoons', hostPruned: 0, sessionEvents: events,
    journal: { lines: 34, ...journalLanes([ENTRY_REWOUND]) } });
  assert.equal(gate.ok, true);
  assert.equal(gate.replaced, 0, 'the rewind lane is never counted as a tool/result replace');
});

test('089 (c) durable-recall: 1 replace == the one applied prune removal', () => {
  const gate = replacementAccounting({ arm: 'racoons', hostPruned: 0,
    sessionEvents: [replace('user/message'), replace('tool/result')],
    journal: { lines: 108, ...journalLanes([PRUNE_APPLIED]) } });
  assert.equal(gate.ok, true);
});

test('089 (d) a replace with no lane behind it is red, naming both sides', () => {
  const gate = replacementAccounting({ arm: 'racoons', hostPruned: 0,
    sessionEvents: [replace('tool/result')],
    journal: { lines: 10, ...journalLanes([]) } });
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /1 tool\/result replacement/u);
  assert.match(gate.detail, /0 applied removal/u);
});

test('089 (d) a lane with no replace is red too: the host refused what the mount planned', () => {
  const gate = replacementAccounting({ arm: 'racoons', hostPruned: 0,
    sessionEvents: [], journal: { lines: 10, ...journalLanes([PRUNE_APPLIED]) } });
  assert.equal(gate.ok, false);
});

test('089 (d) a landed entry shape is one tool/result replace', () => {
  const green = replacementAccounting({ arm: 'racoons', hostPruned: 0,
    sessionEvents: [replace('tool/result')], journal: { lines: 9, ...journalLanes([ENTRY_LANDED]) } });
  assert.equal(green.ok, true);
  const red = replacementAccounting({ arm: 'racoons', hostPruned: 0,
    sessionEvents: [], journal: { lines: 9, ...journalLanes([ENTRY_LANDED]) } });
  assert.equal(red.ok, false);
});

test('089 (d) an applied manual forget is one tool/result replace', () => {
  const gate = replacementAccounting({ arm: 'racoons', hostPruned: 0,
    sessionEvents: [replace('tool/result')], journal: { lines: 9, ...journalLanes([FORGET_APPLIED]) } });
  assert.equal(gate.ok, true);
});

test('089 (d) the host pruner is counted only when it was left mounted', () => {
  // `--end-pressure-isolation` leaves it mounted; the ended run states the
  // count it made, so its trims are a lane with an expected side.
  const green = replacementAccounting({ arm: 'vanilla', hostPruned: 2,
    sessionEvents: [replace('tool/result'), replace('tool/result')], journal: null });
  assert.equal(green.ok, true);
  const red = replacementAccounting({ arm: 'vanilla', hostPruned: 0,
    sessionEvents: [replace('tool/result')], journal: null });
  assert.equal(red.ok, false);
});

test('089 (d) no journal means no comparison, and the gate says so', () => {
  const gate = replacementAccounting({ arm: 'racoons', hostPruned: 0,
    sessionEvents: [replace('tool/result')], journal: null });
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /no journal/u);
});

test('089 (e) the gate names are the ones the docs and the red run print', () => {
  assert.equal(replacementGateName('racoons'),
    "fidelity: the racoons arm's tool/result replacements match the applied removals");
  assert.equal(replacementGateName('vanilla'),
    "fidelity: the vanilla arm's tool/result replacements match the applied removals");
});

test('101 the host pruner is counted when the composed config leaves it mounted', () => {
  // A caller with no composed dump to read: the pruner's state is unknown, so
  // its trims are counted as a lane rather than assumed away.
  assert.equal(hostPrunerTrims({ pruneEvents: 3, isolation: null, endPressureIsolation: false }), 3);
  // The dump read back from `dump-config-host-pruner.yml`: one enabled copy is
  // mounted; every copy disabled is not.
  assert.equal(hostPrunerTrims({ pruneEvents: 3,
    isolation: { rows: 2, disabledRows: 1 }, endPressureIsolation: false }), 3);
  assert.equal(hostPrunerTrims({ pruneEvents: 3,
    isolation: { rows: 2, disabledRows: 2 }, endPressureIsolation: false }), 0);
  // A padded run whose dump read no row was isolated on purpose: 0, not the
  // trims, which only happen when the isolation was ended.
  assert.equal(hostPrunerTrims({ pruneEvents: 3,
    isolation: { rows: 0, disabledRows: 0 }, endPressureIsolation: false }), 0);
  assert.equal(hostPrunerTrims({ pruneEvents: 3,
    isolation: { rows: 0, disabledRows: 0 }, endPressureIsolation: true }), 3);
});

test('101 an unpadded run that compacts accounts for the host pruner trims', () => {
  // 2026-10-29-full-rerun's shape, small: 4 tool/result replaces, 1 landed
  // entry shape, 3 host pruner trims. The run passed no
  // `--end-pressure-isolation`, so the old rule passed 0 and the gate read red.
  const hostPruned = hostPrunerTrims({ pruneEvents: 3, isolation: null, endPressureIsolation: false });
  const green = replacementAccounting({ arm: 'racoons', hostPruned,
    sessionEvents: [replace('tool/result'), replace('tool/result'), replace('tool/result'),
      replace('tool/result')],
    journal: { lines: 40, ...journalLanes([ENTRY_LANDED]) } });
  assert.equal(green.ok, true);
  assert.equal(green.applied, 4);
  // The gate is not weakened: one trim fewer still fails by name.
  const red = replacementAccounting({ arm: 'racoons',
    hostPruned: hostPrunerTrims({ pruneEvents: 2, isolation: null, endPressureIsolation: false }),
    sessionEvents: [replace('tool/result'), replace('tool/result'), replace('tool/result'),
      replace('tool/result')],
    journal: { lines: 40, ...journalLanes([ENTRY_LANDED]) } });
  assert.equal(red.ok, false);
  assert.match(red.detail, /2 host pruner trim/u);
});

