import assert from "node:assert/strict";
import { test } from "node:test";
import { epochsFor } from "../src/epochs/epochs.js";
import { appliedSetAt, normalizeDecision, removalPoint, canonicalRanges, canonicalRemovalSet } from '../src/epochs/removal.js';
import type { Epoch, EpochDecision } from '../src/epochs/types.js';
import { allCallIds, calls, MANIFEST_ROWS, mustEpoch, rows, turnOfCall, wholeUnitDecision, SMALL_CALLS } from './epochs-fixtures.js';

// Ported from `scratchpad/spike-008/v4/lib/selftest-epochs.mjs`: the eleven
// selftest cases plus purity-under-a-double-run, reversed-input identity and a
// barrel-reachability check.
//
// Every row below is one case of one rule. The expected counts and ids come from
// the fixture manifest outside the planner, so a planner that stopped reading
// its decisions would fail the row that pins its boundary.


function epochIndexOf(epochs: readonly Epoch[], callId: string): number | null {
  const epoch = epochs.find(candidate => candidate.callIds.includes(callId));
  return epoch === undefined ? null : epoch.epochIndex;
}

function firstTurnAbove(turn: number, name: string): number {
  const call = calls.find(candidate => candidate.turnIndex > turn);
  assert.ok(call !== undefined, `row: ${name} — a call follows turn ${turn}`);
  return call.turnIndex;
}

type Case = readonly [name: string, run: (name: string) => void];

/** Where a boundary lands, and what each side of it holds. */
const SEGMENT_CASES: readonly Case[] = [
  ["no decisions — one epoch over every call, base required", name => {
    const epochs = epochsFor(calls, []);
    assert.equal(epochs.length, 1, `row: ${name} — no decision makes one epoch`);
    const only = mustEpoch(epochs, 0);
    assert.equal(only.epochIndex, 0, `row: ${name} — the only epoch is index 0`);
    assert.equal(only.firstCallId, calls[0]?.callId, `row: ${name} — it opens on the first call`);
    assert.equal(only.lastCallId, calls[calls.length - 1]?.callId,
      `row: ${name} — it closes on the last call`);
    assert.equal(only.callCount, MANIFEST_ROWS, `row: ${name} — it holds every manifest call`);
    assert.deepEqual(only.callIds, allCallIds, `row: ${name} — its call ids are the whole timeline`);
    assert.equal(only.basePrefixRequired, true, `row: ${name} — a base is required at epoch 0`);
    assert.equal(only.appliedRemovalSet, "[]", `row: ${name} — nothing is applied`);
    assert.deepEqual(only.activatedUnitIds, [], `row: ${name} — nothing activates`);
    assert.equal(epochsFor(calls, undefined).length, 1, `row: ${name} — decisions defaults to []`);
  }],
  ["one decision at turn 11 — the boundary is the first call after turn 11", name => {
    const decision = wholeUnitDecision(11, 3);
    const epochs = epochsFor(calls, [decision]);
    assert.equal(epochs.length, 2, `row: ${name} — one decision splits the timeline once`);
    const pristine = mustEpoch(epochs, 0);
    const mutated = mustEpoch(epochs, 1);

    const boundary = calls.find(call => call.turnIndex > 11);
    assert.ok(boundary !== undefined, `row: ${name} — a call follows turn 11`);
    assert.equal(mutated.firstCallId, boundary.callId,
      `row: ${name} — the new epoch opens on the first call after the decision's turn`);
    assert.equal(mutated.firstTurnIndex, 12, `row: ${name} — the boundary turn is 12`);
    assert.equal(pristine.firstTurnIndex, 0, `row: ${name} — the pristine epoch starts at 0`);
    assert.equal(pristine.lastTurnIndex, 11,
      `row: ${name} — the pristine epoch ends on the decision's own turn`);
    assert.equal(pristine.appliedRemovalSet, "[]", `row: ${name} — the pristine epoch applies nothing`);
    assert.deepEqual(pristine.callIds,
      calls.filter(call => call.turnIndex <= 11).map(call => call.callId),
      `row: ${name} — the pristine epoch holds exactly the calls at or before turn 11`);
    assert.equal(pristine.callCount, 95, `row: ${name} — 95 manifest calls sit at or below turn 11`);
    assert.equal(pristine.callCount + mutated.callCount, MANIFEST_ROWS,
      `row: ${name} — the two epochs partition the manifest`);

    for (const callId of pristine.callIds) {
      assert.ok(turnOfCall(callId) <= 11,
        `row: ${name} — pristine call ${callId} sits at or before turn 11`);
    }
    for (const callId of mutated.callIds) {
      assert.ok(turnOfCall(callId) > 11, `row: ${name} — mutated call ${callId} sits after turn 11`);
    }
    assert.equal(mutated.lastCallId, calls[calls.length - 1]?.callId,
      `row: ${name} — the mutated epoch runs to the last call`);
    assert.equal(pristine.basePrefixRequired, true, `row: ${name} — the pristine epoch needs a base`);
    assert.equal(mutated.basePrefixRequired, true,
      `row: ${name} — the re-rendered epoch needs a base too`);
    assert.deepEqual(mutated.activatedUnitIds, [decision.unitId],
      `row: ${name} — only the decided unit activates at the boundary`);
    assert.equal(
      mutated.appliedRemovalSet,
      JSON.stringify([{
        unitId: decision.unitId,
        ranges: [{ startLine: 1, endLineInclusive: rows[3]?.unitLines }],
      }]),
      `row: ${name} — the applied set is the decision's canonical JSON`,
    );
  }],
  ["two decisions at one turn — one boundary, never two", name => {
    const together = epochsFor(calls, [wholeUnitDecision(11, 1), wholeUnitDecision(11, 2)]);
    assert.equal(together.length, 2, `row: ${name} — two decisions at one turn split once`);
    assert.equal(mustEpoch(together, 1).firstTurnIndex, 12,
      `row: ${name} — the shared boundary lands at turn 12`);
    assert.deepEqual(
      mustEpoch(together, 1).activatedUnitIds,
      [rows[1]?.unitId, rows[2]?.unitId].sort(),
      `row: ${name} — both decided units activate at that one boundary`,
    );

    const spread = epochsFor(calls, [wholeUnitDecision(4, 1), wholeUnitDecision(4, 2)]);
    assert.equal(spread.length, 2, `row: ${name} — the turn-4 pair also splits once`);
    assert.equal(mustEpoch(spread, 1).firstTurnIndex, 5,
      `row: ${name} — its boundary lands at turn 5`);
    assert.equal(mustEpoch(spread, 1).callCount, MANIFEST_ROWS - 49,
      `row: ${name} — 49 calls sit at turn 4 or below`);

    // A decision on a turn with no calls still lands at the next call after it.
    const emptyTurn = epochsFor(calls, [wholeUnitDecision(7, 1)]);
    assert.equal(emptyTurn.length, 2, `row: ${name} — an empty turn still splits the timeline`);
    assert.equal(mustEpoch(emptyTurn, 1).firstTurnIndex, firstTurnAbove(7, name),
      `row: ${name} — the boundary is the first turn that carries a call`);
    assert.equal(mustEpoch(emptyTurn, 1).epochIndex, 1,
      `row: ${name} — the new epoch is index 1`);
  }],
  ["keepall-only decisions — empty ranges add no boundary", name => {
    const keepall: readonly EpochDecision[] = [
      { turn: 0, unitId: rows[0]?.unitId ?? "", ranges: [] },
      { turn: 11, unitId: rows[1]?.unitId ?? "", ranges: [] },
      { turn: 40, unitId: rows[2]?.unitId ?? "", ranges: [] },
    ];
    const epochs = epochsFor(calls, keepall);
    assert.equal(epochs.length, 1, `row: ${name} — a keepall removes nothing, so no boundary`);
    assert.equal(mustEpoch(epochs, 0).callCount, MANIFEST_ROWS,
      `row: ${name} — the single epoch still holds every call`);
    assert.equal(mustEpoch(epochs, 0).appliedRemovalSet, "[]",
      `row: ${name} — the applied set stays empty`);
    assert.equal(canonicalRemovalSet(keepall), "[]",
      `row: ${name} — a keepall list canonicalises to nothing`);

    const first = keepall[0];
    assert.ok(first !== undefined, `row: ${name} — the fixture list has a first decision`);
    assert.equal(removalPoint(first), 0, `row: ${name} — keepall is still a valid decision`);

    // A keepall at the same turn as a real decision adds no boundary of its own.
    const mixed = epochsFor(calls, [
      wholeUnitDecision(19, 4),
      { turn: 19, unitId: rows[5]?.unitId ?? "", ranges: [] },
    ]);
    assert.equal(mixed.length, 2, `row: ${name} — only the real decision splits`);
    assert.equal(mustEpoch(mixed, 1).firstTurnIndex, 20,
      `row: ${name} — the boundary is the real decision's turn plus one`);
    assert.deepEqual(mustEpoch(mixed, 1).activatedUnitIds, [rows[4]?.unitId],
      `row: ${name} — only the real decision's unit activates`);
    assert.equal(epochsFor(SMALL_CALLS, [
      { turn: 0, unitId: "u1", ranges: [] },
      { turn: 3, unitId: "u2", ranges: [] },
    ]).length, 1, `row: ${name} — two keepalls over four calls still make one epoch`);
  }],
  ["same-turn calls — one epoch, and no group straddles a boundary", name => {
    const epochs = epochsFor(calls, [wholeUnitDecision(11, 3)]);
    for (const epoch of epochs) {
      assert.deepEqual(
        epoch.sameTurnGroups.flatMap(group => group.callIds),
        epoch.callIds,
        `row: ${name} — epoch ${epoch.epochIndex} groups cover its calls in order`,
      );
      for (const group of epoch.sameTurnGroups) {
        assert.ok(group.callIds.length >= 1,
          `row: ${name} — epoch ${epoch.epochIndex} turn ${group.turnIndex} names a call`);
        for (const callId of group.callIds) {
          assert.equal(turnOfCall(callId), group.turnIndex,
            `row: ${name} — ${callId} sits at its group's turn`);
          assert.equal(epochIndexOf(epochs, callId), epoch.epochIndex,
            `row: ${name} — same-turn call ${callId} stays in one epoch`);
        }
      }
      for (let index = 1; index < epoch.sameTurnGroups.length; index += 1) {
        assert.ok((epoch.sameTurnGroups[index]?.turnIndex ?? -1)
          > (epoch.sameTurnGroups[index - 1]?.turnIndex ?? -1),
        `row: ${name} — epoch ${epoch.epochIndex} groups ascend by turn`);
      }
    }

    assert.equal(mustEpoch(epochs, 1).sameTurnGroups[0]?.turnIndex, 12,
      `row: ${name} — the mutated epoch opens on turn 12's group`);
    const pristineGroups = mustEpoch(epochs, 0).sameTurnGroups;
    assert.equal(pristineGroups[pristineGroups.length - 1]?.turnIndex, 11,
      `row: ${name} — the pristine epoch closes on turn 11's group`);

    // Turn 11 carries 25 calls: one group, one epoch, so their prefixes must be
    // byte-equal (same applied set, same turn blocks).
    const turnEleven = pristineGroups.find(group => group.turnIndex === 11);
    assert.ok(turnEleven !== undefined, `row: ${name} — turn 11 forms a group`);
    assert.equal(turnEleven.callIds.length, 25, `row: ${name} — 25 calls share turn 11`);
    assert.equal(new Set(turnEleven.callIds.map(callId => epochIndexOf(epochs, callId))).size, 1,
      `row: ${name} — every turn-11 call lands in one epoch`);

    // A decision at a turn whose group is large still splits cleanly after it.
    const turn0 = epochsFor(calls, [wholeUnitDecision(0, 0)]);
    assert.equal(turn0.length, 2, `row: ${name} — a turn-0 decision splits the timeline`);
    assert.equal(mustEpoch(turn0, 0).callCount, 26,
      `row: ${name} — 26 calls share turn 0 and stay in the pristine epoch`);
    assert.equal(mustEpoch(turn0, 0).sameTurnGroups.length, 1,
      `row: ${name} — those 26 calls are one group`);
    assert.equal(mustEpoch(turn0, 1).firstTurnIndex, 1,
      `row: ${name} — the boundary lands at the next turn`);

    const small = epochsFor(SMALL_CALLS, [
      { turn: 0, unitId: "u1", ranges: [{ startLine: 1, endLineInclusive: 2 }] },
    ]);
    assert.equal(small.length, 2, `row: ${name} — the four-call fixture splits once`);
    assert.deepEqual(mustEpoch(small, 0).callIds, ["c0a", "c0b"],
      `row: ${name} — the pristine epoch holds both turn-0 calls`);
    assert.equal(mustEpoch(small, 0).sameTurnGroups[0]?.turnIndex, 0,
      `row: ${name} — its one group is turn 0`);
    assert.deepEqual(mustEpoch(small, 0).sameTurnGroups[0]?.callIds, ["c0a", "c0b"],
      `row: ${name} — the group names both turn-0 calls`);
    assert.deepEqual(mustEpoch(small, 1).callIds, ["c1", "c3"],
      `row: ${name} — both later turns land in the mutated epoch`);
  }],
];

/** End-of-turn semantics, canonical line ranges, and the refusals both own. */
const REMOVAL_CASES: readonly Case[] = [
  ["removalPoint — end-of-turn: applied after T, seen from T+1", name => {
    const decision = wholeUnitDecision(11, 3);
    assert.equal(removalPoint(decision), 11, `row: ${name} — a decision applies at its own turn`);
    assert.deepEqual(appliedSetAt([decision], 0), [],
      `row: ${name} — a call before the turn sees nothing`);
    assert.deepEqual(appliedSetAt([decision], 11), [],
      `row: ${name} — a call at T does not see its own turn's decision`);
    assert.equal(appliedSetAt([decision], 12).length, 1, `row: ${name} — a call at T+1 sees it`);
    assert.equal(appliedSetAt([decision], 50).length, 1,
      `row: ${name} — every later call keeps seeing it`);

    // Many decisions accumulate in stable unitId order.
    const many = [wholeUnitDecision(40, 1), wholeUnitDecision(5, 2), wholeUnitDecision(19, 3)];
    assert.deepEqual(
      appliedSetAt(many, 50).map(entry => entry.unitId),
      [rows[1]?.unitId, rows[2]?.unitId, rows[3]?.unitId].sort(),
      `row: ${name} — the applied set sorts by unitId, whatever the input order`,
    );
    assert.deepEqual(appliedSetAt(many, 5), [],
      `row: ${name} — nothing decided at turn 5 or later is visible at turn 5`);
  }],
  ["line ranges canonicalise — sorted, merged, validated, idempotent", name => {
    // Adjacent spans merge; a gap of one missing line does not (3 > 1 + 1).
    assert.deepEqual(
      canonicalRanges([
        { startLine: 3, endLineInclusive: 3 },
        { startLine: 4, endLineInclusive: 5 },
        { startLine: 1, endLineInclusive: 1 },
      ]),
      [{ startLine: 1, endLineInclusive: 1 }, { startLine: 3, endLineInclusive: 5 }],
      `row: ${name} — the output is sorted, and a one-line gap survives`,
    );
    assert.deepEqual(
      canonicalRanges([
        { startLine: 1, endLineInclusive: 2 },
        { startLine: 3, endLineInclusive: 5 },
      ]),
      [{ startLine: 1, endLineInclusive: 5 }],
      `row: ${name} — touching spans merge`,
    );
    assert.deepEqual(
      canonicalRanges([
        { startLine: 9, endLineInclusive: 12 },
        { startLine: 2, endLineInclusive: 3 },
        { startLine: 1, endLineInclusive: 2 },
      ]),
      [{ startLine: 1, endLineInclusive: 3 }, { startLine: 9, endLineInclusive: 12 }],
      `row: ${name} — unsorted overlapping spans merge into disjoint sorted ones`,
    );
    const once = canonicalRanges([{ startLine: 5, endLineInclusive: 6 }]);
    assert.deepEqual(canonicalRanges(once), once,
      `row: ${name} — canonical form is a fixed point`);
    assert.equal(Object.isFrozen(once), true, `row: ${name} — the list is frozen`);
    assert.equal(Object.isFrozen(once[0]), true, `row: ${name} — each span is frozen`);

    // The canonical set merges equivalent-but-unmerged ranges into one span.
    assert.equal(
      canonicalRemovalSet([{
        turn: 2, unitId: "u",
        ranges: [{ startLine: 1, endLineInclusive: 2 }, { startLine: 3, endLineInclusive: 5 }],
      }]),
      JSON.stringify([{ unitId: "u", ranges: [{ startLine: 1, endLineInclusive: 5 }] }]),
      `row: ${name} — the canonical set serialises the merged union`,
    );

    // Unsorted duplicate decisions collapse to one entry, so no phantom boundary.
    const epochs = epochsFor(calls, [
      { turn: 11, unitId: "u", ranges: [{ startLine: 2, endLineInclusive: 3 }] },
      { turn: 11, unitId: "u", ranges: [{ startLine: 1, endLineInclusive: 3 }] },
    ]);
    assert.equal(epochs.length, 2,
      `row: ${name} — two overlapping decisions on one unit make one boundary`);
    assert.equal(
      mustEpoch(epochs, 1).appliedRemovalSet,
      JSON.stringify([{ unitId: "u", ranges: [{ startLine: 1, endLineInclusive: 3 }] }]),
      `row: ${name} — the applied set is their merged union, not two entries`,
    );
  }],
  ["invalid input is refused with its own error type", name => {
    for (const bad of [undefined, null, 1.5, "3", -1]) {
      assert.throws(() => appliedSetAt([], bad as unknown as number), TypeError,
        `row: ${name} — appliedSetAt refuses turn ${String(bad)}`);
    }
    assert.throws(() => removalPoint({ turn: -1, unitId: "u", ranges: [] }), TypeError,
      `row: ${name} — removalPoint refuses a negative turn`);
    assert.throws(() => removalPoint({ turn: 1, unitId: "", ranges: [] }), TypeError,
      `row: ${name} — removalPoint refuses an empty unitId`);
    assert.throws(() => normalizeDecision({ turn: 1, unitId: "u", ranges: "nope" }), TypeError,
      `row: ${name} — normalizeDecision refuses a non-array ranges`);
    assert.throws(
      () => normalizeDecision({ turn: 1, unitId: "u", ranges: [{ startLine: 0, endLineInclusive: 1 }] }),
      RangeError,
      `row: ${name} — normalizeDecision refuses a line range below one`,
    );
  }],
];

/** Purity, deep freeze, and the two views agreeing call by call. */
const PURITY_CASES: readonly Case[] = [
  ["repeated and reversed calls — byte-identical output, inputs untouched", name => {
    const decisions = [wholeUnitDecision(11, 3), wholeUnitDecision(19, 4), wholeUnitDecision(11, 6)];
    const first = JSON.stringify(epochsFor(calls, decisions));
    assert.equal(JSON.stringify(epochsFor(calls, decisions)), first,
      `row: ${name} — a second call with equal input is byte-identical`);
    assert.equal(JSON.stringify(epochsFor(calls, [...decisions].reverse())), first,
      `row: ${name} — decision order changes no byte`);

    // Inputs are not mutated by the planner.
    const callsCopy = JSON.stringify(calls);
    const decisionsCopy = JSON.stringify(decisions);
    epochsFor(calls, decisions);
    assert.equal(JSON.stringify(calls), callsCopy, `row: ${name} — the call list is untouched`);
    assert.equal(JSON.stringify(decisions), decisionsCopy,
      `row: ${name} — the decision list is untouched`);
  }],
  ["output is frozen at every level a consumer can reach", name => {
    const decisions = [wholeUnitDecision(11, 3), wholeUnitDecision(19, 4), wholeUnitDecision(11, 6)];
    const epochs = epochsFor(calls, decisions);
    assert.equal(Object.isFrozen(epochs), true, `row: ${name} — the epoch list is frozen`);
    assert.equal(Object.isFrozen(mustEpoch(epochs, 0)), true, `row: ${name} — each epoch is frozen`);
    assert.equal(Object.isFrozen(mustEpoch(epochs, 0).callIds), true,
      `row: ${name} — the epoch's callIds are frozen`);
    assert.equal(Object.isFrozen(mustEpoch(epochs, 0).sameTurnGroups), true,
      `row: ${name} — the epoch's sameTurnGroups are frozen`);
    assert.equal(Object.isFrozen(mustEpoch(epochs, 1).sameTurnGroups[0]), true,
      `row: ${name} — each same-turn group is frozen`);
    assert.equal(Object.isFrozen(mustEpoch(epochs, 1).activatedUnitIds), true,
      `row: ${name} — activatedUnitIds is frozen`);
    assert.throws(() => {
      "use strict";
      (mustEpoch(epochs, 0) as unknown as { epochIndex: number }).epochIndex = 99;
    }, TypeError, `row: ${name} — a consumer cannot write an epoch field`);
  }],
  ["appliedSetAt — frozen, empty-safe, and order-free at every turn", name => {
    const decisions = [
      wholeUnitDecision(11, 3), wholeUnitDecision(19, 4),
      { turn: 19, unitId: "keep", ranges: [] },
    ];
    for (const turn of [0, 11, 12, 19, 20, 50, 10_000]) {
      assert.deepEqual(appliedSetAt(decisions, turn), appliedSetAt([...decisions].reverse(), turn),
        `row: ${name} — turn ${turn} reads the same set whatever the decision order`);
    }
    const late = appliedSetAt(decisions, 20);
    assert.equal(Object.isFrozen(late), true, `row: ${name} — the applied list is frozen`);
    assert.equal(Object.isFrozen(late[0]), true, `row: ${name} — each applied entry is frozen`);
    assert.deepEqual(appliedSetAt([], 7), [], `row: ${name} — no decisions reads as empty`);
    assert.equal(Object.isFrozen(appliedSetAt([], 7)), true,
      `row: ${name} — the empty result is frozen too`);
  }],
  ["appliedSetAt agrees with epochsFor call by call", name => {
    const decisions = [
      wholeUnitDecision(11, 3), wholeUnitDecision(19, 4),
      { turn: 19, unitId: "keep", ranges: [] },
    ];
    const epochs = epochsFor(calls, decisions);
    let checked = 0;
    for (const epoch of epochs) {
      for (const call of calls) {
        if (!epoch.callIds.includes(call.callId)) continue;
        assert.equal(epoch.appliedRemovalSet, JSON.stringify(appliedSetAt(decisions, call.turnIndex)),
          `row: ${name} — epoch ${epoch.epochIndex} call ${call.callId} sees its own turn's set`);
        checked += 1;
      }
    }
    assert.equal(checked, MANIFEST_ROWS,
      `row: ${name} — every manifest call was compared exactly once`);
  }],
];

function runCases(cases: readonly Case[]): void {
  for (const [name, run] of cases) run(name);
}

test("epochs segment the timeline at each distinct applied set", () => {
  runCases(SEGMENT_CASES);
});

test("decisions apply at end of turn, and line ranges canonicalise", () => {
  runCases(REMOVAL_CASES);
});

test("the planner is pure, frozen throughout, and agrees with appliedSetAt", () => {
  runCases(PURITY_CASES);
});

// --- last-turn reuse must not outlive its own call (ISSUE-385) --------------

test("same-turn reuse never hides a decision list changed between calls (ISSUE-385)", () => {
  const decisions: EpochDecision[] = [
    { turn: 0, unitId: "u1", ranges: [{ startLine: 1, endLineInclusive: 2 }] },
  ];
  const before = epochsFor(SMALL_CALLS, decisions);
  assert.equal(before.length, 2, "the turn-0 decision splits once");
  assert.deepEqual(mustEpoch(before, 0).callIds, ["c0a", "c0b"],
    "both turn-0 calls share one epoch and one applied set");
  assert.deepEqual(mustEpoch(before, 1).callIds, ["c1", "c3"]);

  // Same calls, same turn indexes: only the decision list changes, in place.
  // A memo keyed on turnIndex alone that outlives the call would serve the
  // first call's applied sets here (stale cache) and miss the new boundary.
  decisions.push({ turn: 1, unitId: "u2", ranges: [{ startLine: 1, endLineInclusive: 3 }] });
  const after = epochsFor(SMALL_CALLS, decisions);
  assert.equal(after.length, 3, "the landed turn-1 decision splits c1 from c3");
  assert.deepEqual(mustEpoch(after, 1).callIds, ["c1"]);
  assert.deepEqual(mustEpoch(after, 2).callIds, ["c3"]);
  assert.equal(mustEpoch(after, 2).appliedRemovalSet, JSON.stringify([
    { unitId: "u1", ranges: [{ startLine: 1, endLineInclusive: 2 }] },
    { unitId: "u2", ranges: [{ startLine: 1, endLineInclusive: 3 }] },
  ]), "the last epoch sees both decisions");

  // An edited decision object is re-read too, at the very same turn indexes.
  decisions[0] = { turn: 0, unitId: "u1", ranges: [{ startLine: 1, endLineInclusive: 5 }] };
  const edited = epochsFor(SMALL_CALLS, decisions);
  assert.equal(mustEpoch(edited, 2).appliedRemovalSet, JSON.stringify([
    { unitId: "u1", ranges: [{ startLine: 1, endLineInclusive: 5 }] },
    { unitId: "u2", ranges: [{ startLine: 1, endLineInclusive: 3 }] },
  ]), "the edited range is seen");
  assert.deepEqual(epochsFor(SMALL_CALLS, decisions), edited, "reuse changes no byte");
});
