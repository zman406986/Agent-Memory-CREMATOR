import assert from "node:assert/strict";
import { test } from "node:test";
import { EpisodeTracker } from "../src/episodes/tracker.js";
import type { Episode, EpisodeDetectionInput } from "../src/episodes/types.js";
import { SealRule } from "../src/rules/seal.js";
import type { PathEvidence, ToolResultNode } from "../src/types/transcript.js";
import { sha256Sync } from "../src/util/hash.js";
import { ruleContext } from "./rules-fixtures.js";

function path(pathKey: string, outcome: PathEvidence["outcome"] = "miss"): PathEvidence {
  return { pathKey, displayPath: pathKey, title: null, lineCount: 3, byteLength: 8, outcome };
}

function result(
  id: string, target: string | null, stepOrdinal: number,
  paths: readonly PathEvidence[], turnOrdinal = 1,
): ToolResultNode {
  const bytes = new TextEncoder().encode(`result ${id}\r\n`);
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result", id, turnOrdinal, stepOrdinal, bytes, sha256,
    byteLength: bytes.byteLength, callId: `call-${id}`, embeddedRecords: [],
    evidence: {
      kind: "search", target: target === null ? null : { key: target, label: target },
      paths, source: { nodeId: id, sha256, byteLength: bytes.byteLength },
      sourceRecallId: null,
    },
  };
}

function input(
  results: readonly ToolResultNode[], currentStepOrdinal: number,
  completedThroughTurnOrdinal = 0,
): EpisodeDetectionInput {
  return { sessionId: "session-1", results, currentStepOrdinal, completedThroughTurnOrdinal };
}

function episodeAt(episodes: readonly Episode[], index = 0): Episode {
  const episode = episodes[index];
  assert.ok(episode, `missing episode at index ${index}`);
  return episode;
}

const turnEndOnly = (): EpisodeTracker => new EpisodeTracker({ noNewPathSteps: null });

interface CloseRow {
  readonly row: string;
  readonly threshold: number | null;
  readonly results: readonly ToolResultNode[];
  readonly currentStep: number;
  readonly completedThroughTurn: number;
  readonly reason: "path-idle" | "turn-end";
  readonly closedAtStep: number;
  readonly closedAtTurn: number;
}

/**
 * One closure per row, pinned from the row's own arithmetic: step and turn are
 * computed by hand, never read back off the tracker's answer.
 */
const CLOSE_ROWS: readonly CloseRow[] = [
  {
    row: "a completed turn under a null threshold",
    threshold: null,
    results: [result("a1", "alpha", 1, [path("a.ts")]), result("a2", "alpha", 2, [path("a.ts")])],
    currentStep: 2, completedThroughTurn: 1,
    reason: "turn-end", closedAtStep: 2, closedAtTurn: 1,
  },
  {
    row: "path-idle closing exactly three steps past the last new path",
    threshold: 3,
    results: [result("a1", "alpha", 1, [path("a.ts")]), result("a2", "alpha", 3, [path("a.ts")])],
    currentStep: 4, completedThroughTurn: 0,
    reason: "path-idle", closedAtStep: 4, closedAtTurn: 1,
  },
  {
    row: "path-idle winning when both closure conditions apply at one observation",
    threshold: 3,
    results: [result("a1", "alpha", 1, [path("a.ts")])],
    currentStep: 4, completedThroughTurn: 1,
    reason: "path-idle", closedAtStep: 4, closedAtTurn: 1,
  },
];

test("every closure reason is pinned: path-idle wins, turn-end needs a completed turn, null sets no limit", () => {
  for (const row of CLOSE_ROWS) {
    const tracker = new EpisodeTracker({ noNewPathSteps: row.threshold });
    const closed = episodeAt(tracker.detect(input(row.results, row.currentStep, row.completedThroughTurn)));
    assert.equal(closed.closeReason, row.reason, `row: ${row.row} — the close reason drifted`);
    assert.equal(closed.status, "closed", `row: ${row.row} — the episode is not closed`);
    assert.equal(closed.closedAtStep, row.closedAtStep, `row: ${row.row} — closedAtStep drifted`);
    assert.equal(closed.closedAtTurn, row.closedAtTurn, `row: ${row.row} — closedAtTurn drifted`);
    assert.equal(closed.lastNewPathStep, 1, `row: ${row.row} — the last new path moved`);
  }

  // A closure is a fixed point: the same results at a much later step re-report it.
  const idle = CLOSE_ROWS[1];
  assert.ok(idle !== undefined, "row: a fixed point — the path-idle row is missing");
  const tracker = new EpisodeTracker({ noNewPathSteps: idle.threshold });
  assert.deepEqual(episodeAt(tracker.detect(input(idle.results, 20))),
    episodeAt(tracker.detect(input(idle.results, idle.currentStep))),
    "row: a fixed point — a later current step rewrote a closed episode");

  // A null threshold imposes no idle limit: a huge step still leaves it open, and
  // closing it needs the turn, not the step.
  const turnRow = CLOSE_ROWS[0];
  assert.ok(turnRow !== undefined, "row: no idle limit — the turn-end row is missing");
  const open = episodeAt(turnEndOnly().detect(input(turnRow.results, 100)));
  assert.equal(open.status, "open", "row: no idle limit — a null threshold closed the episode");
  assert.equal(open.closedAtStep, null, "row: no idle limit — closedAtStep is not null");
  assert.equal(open.closedAtTurn, null, "row: no idle limit — closedAtTurn is not null");
  assert.equal(open.closeReason, null, "row: no idle limit — a close reason was set");
  assert.equal(open.lastNewPathStep, 1, "row: no idle limit — the last new path moved");
  const turned = episodeAt(turnEndOnly().detect(input(turnRow.results, 100, 1)));
  assert.equal(turned.id, open.id, "row: no idle limit — the turn-end close changed the episode id");
  assert.equal(turned.closeReason, "turn-end",
    "row: no idle limit — the completed turn did not close the episode that the step could not");

  // Just below the threshold stays open; the threshold step closes it.
  const below = episodeAt(tracker.detect(input(idle.results, 3)));
  assert.equal(below.status, "open", "row: one step below — the episode closed early");
  assert.equal(below.closeReason, null, "row: one step below — a close reason was set");
});

interface EvidenceRow {
  readonly row: string;
  readonly results: readonly ToolResultNode[];
  readonly completedThroughTurn: number;
  readonly hit: readonly string[];
  readonly miss: readonly string[];
  readonly unknown: readonly string[];
}

/**
 * The evidence classification per result: a hit anywhere wins, an all-miss path
 * list is a miss, and unknown-only, mixed or empty evidence is never a miss.
 */
const EVIDENCE_ROWS: readonly EvidenceRow[] = [
  {
    row: "unknown-only, empty, mixed and a single hit",
    results: [
      result("unknown", "alpha", 1, [path("a.ts", "unknown")]),
      result("mixed", "alpha", 2, [path("b.ts"), path("c.ts", "unknown")]),
      result("empty", "alpha", 3, []),
      result("miss", "alpha", 4, [path("d.ts"), path("e.ts")]),
      result("hit", "alpha", 5, [path("f.ts", "unknown"), path("g.ts", "hit")]),
    ],
    completedThroughTurn: 0,
    unknown: ["unknown", "mixed", "empty"], miss: ["miss"], hit: ["hit"],
  },
  {
    row: "a hit surviving later misses and unknown observations of the same path",
    results: [
      result("miss", "alpha", 1, [path("a.ts")]),
      result("hit", "alpha", 2, [path("a.ts", "hit")]),
      result("later-miss", "alpha", 3, [path("a.ts")]),
      result("unknown", "alpha", 4, [path("a.ts", "unknown")]),
    ],
    completedThroughTurn: 1,
    unknown: ["unknown"], miss: ["miss", "later-miss"], hit: ["hit"],
  },
];

test("evidence classification per result is pinned, and a hit survives a later miss of the same path", () => {
  for (const row of EVIDENCE_ROWS) {
    const episode = episodeAt(turnEndOnly().detect(
      input(row.results, row.results.length, row.completedThroughTurn)));
    assert.deepEqual(episode.hitNodeIds, row.hit, `row: ${row.row} — the hit ids drifted`);
    assert.deepEqual(episode.missNodeIds, row.miss, `row: ${row.row} — the miss ids drifted`);
    assert.deepEqual(episode.unknownNodeIds, row.unknown, `row: ${row.row} — the unknown ids drifted`);
    assert.deepEqual(episode.memberNodeIds, [...row.results.map(r => r.id)],
      `row: ${row.row} — the episode does not hold every result of its target`);
  }
  // The retained path record is the first observation with its outcome raised to
  // hit: the first row's hit path keeps its first display metadata.
  const first = path("a.ts");
  const hitRow = EVIDENCE_ROWS[1];
  assert.ok(hitRow !== undefined, "row: a hit surviving — the hit row is missing");
  const episode = episodeAt(turnEndOnly().detect(input(hitRow.results, 4, 1)));
  assert.deepEqual(episode.paths, [{ ...first, outcome: "hit" }],
    "row: a hit surviving — the retained path record is not the first observation raised to hit");
  assert.equal(episode.lastNewPathStep, 1,
    "row: a hit surviving — a repeated path advanced the new-path step");
});

test("targets stay independent: interleaved targets, first-seen order, metadata, and a reopened episode", () => {
  const interleaved = turnEndOnly().detect(input([
    result("a1", "alpha", 1, [path("a.ts")]),
    result("b1", "beta", 2, [path("b.ts", "hit")]),
    result("a2", "alpha", 3, [path("c.ts")]),
    result("b2", "beta", 4, [path("d.ts")]),
  ], 4));
  assert.equal(interleaved.length, 2, "row: interleaved targets — the wrong episode count");
  assert.deepEqual(episodeAt(interleaved).memberNodeIds, ["a1", "a2"],
    "row: interleaved targets — alpha's membership drifted");
  assert.deepEqual(episodeAt(interleaved, 1).memberNodeIds, ["b1", "b2"],
    "row: interleaved targets — beta's membership drifted");
  assert.deepEqual(episodeAt(interleaved, 1).hitNodeIds, ["b1"],
    "row: interleaved targets — beta's hit ids drifted");
  assert.equal(episodeAt(interleaved).lastNewPathStep, 3,
    "row: interleaved targets — alpha's last new path drifted");
  assert.equal(episodeAt(interleaved, 1).lastNewPathStep, 4,
    "row: interleaved targets — beta's last new path drifted");

  // A repeated path keeps the first display metadata and does not advance the step.
  const first = { ...path("a.ts"), displayPath: "original/a.ts", title: "First" };
  const later = { ...path("a.ts", "hit"), displayPath: "alias/a.ts", title: "Later" };
  const tracker = turnEndOnly();
  const repeatedResults = [
    result("a1", "alpha", 1, [first]), result("a2", "alpha", 3, [later]),
  ];
  const repeated = episodeAt(tracker.detect(input(repeatedResults, 3)));
  assert.equal(repeated.lastNewPathStep, 1,
    "row: repeated path — the alias advanced the new-path step");
  assert.deepEqual(repeated.paths, [{ ...first, outcome: "hit" }],
    "row: repeated path — the metadata or outcome drifted");
  const extended = episodeAt(tracker.detect(input([
    ...repeatedResults, result("a3", "alpha", 4, [path("b.ts")]),
  ], 4)));
  assert.equal(extended.lastNewPathStep, 4,
    "row: repeated path — a genuinely new path did not advance the step");
  assert.equal(extended.paths.length, 2, "row: repeated path — the new path was not retained");

  // A late result for a closed target REOPENS its episode (ISSUE-329): the burst
  // continues under the same id, the new member joins, and the episode is open again.
  const idle = new EpisodeTracker({ noNewPathSteps: 3 });
  const seed = result("a1", "alpha", 1, [path("a.ts")]);
  const closed = episodeAt(idle.detect(input([seed], 4)));
  const grown = idle.detect(input([seed, result("a2", "alpha", 5, [path("b.ts")])], 5));
  assert.equal(grown.length, 1, "row: reopened target — the late result opened a separate episode");
  const reopened = episodeAt(grown);
  assert.equal(reopened.id, closed.id, "row: reopened target — the reopened episode changed id");
  assert.deepEqual(reopened.memberNodeIds, ["a1", "a2"],
    "row: reopened target — the late member did not join the episode");
  assert.equal(reopened.status, "open", "row: reopened target — the episode did not reopen");
  assert.equal(reopened.lastNewPathStep, 5,
    "row: reopened target — the new path did not advance the step");
});

test("forgetting the first member keeps the episode id and blocks a duplicate seal (ISSUE-335)", () => {
  const tracker = new EpisodeTracker({ noNewPathSteps: 3 });
  const a1 = result("a1", "alpha", 1, [path("a.ts")]);
  const a2 = result("a2", "alpha", 2, [path("a.ts")]);
  const whole = episodeAt(tracker.detect(input([a1, a2], 4)));
  assert.equal(whole.status, "closed", "the miss-only episode must close path-idle");
  assert.deepEqual(whole.memberNodeIds, ["a1", "a2"], "both members join one episode");

  // The seal commits against the whole episode's id.
  const seal = new SealRule();
  const firstPlan = seal.plan(ruleContext({
    snapshot: { currentTurnOrdinal: 1 }, episodes: [whole], sealedEpisodeIds: [],
  }));
  assert.ok(firstPlan !== null, "the closed miss-only episode must seal");
  const sealedIds = [whole.id];

  // Forget the first member: the transcript now carries only a2.
  const afterForget = episodeAt(tracker.detect(input([a2], 4)));
  assert.equal(afterForget.id, whole.id,
    "forgetting the first member re-keyed the episode");

  // The duplicate negative-fact check must still hold after the forget.
  const reSeal = seal.plan(ruleContext({
    snapshot: { currentTurnOrdinal: 1 }, episodes: [afterForget], sealedEpisodeIds: sealedIds,
  }));
  assert.equal(reSeal, null,
    "the re-keyed episode bypassed the seal duplicate-check and re-sealed");
});

test("a late hit reconciles into the sealed episode; no false negative fact (ISSUE-329)", () => {
  const tracker = new EpisodeTracker({ noNewPathSteps: 3 });
  const miss = result("m1", "alpha", 1, [path("a.ts")]);
  const closed = episodeAt(tracker.detect(input([miss], 4, 1)));
  assert.equal(closed.status, "closed", "the miss-only episode must close");
  assert.deepEqual(closed.missNodeIds, ["m1"], "the episode is miss-only before the late hit");

  const seal = new SealRule();
  const committed = seal.plan(ruleContext({
    snapshot: { currentTurnOrdinal: 1 }, episodes: [closed], sealedEpisodeIds: [],
  }));
  assert.ok(committed !== null, "the closed miss-only episode seals");
  const sealedIds = [closed.id];

  // The interrupted call finishes: a late hit for the same target and path lands.
  const hit = result("h1", "alpha", 5, [path("a.ts", "hit")], 2);
  const after = tracker.detect(input([miss, hit], 5, 1));
  assert.equal(after.length, 1,
    "the late hit opened a separate episode instead of reconciling into the sealed one");
  const reconciled = episodeAt(after);
  assert.equal(reconciled.id, closed.id, "the reconciled episode kept the sealed id");
  assert.deepEqual(reconciled.memberNodeIds, ["m1", "h1"], "the late hit did not join the episode");
  assert.deepEqual(reconciled.hitNodeIds, ["h1"], "the sealed episode does not reflect the late hit");

  // No false "do not re-read": given the late evidence the rule seals nothing,
  // whether or not the old seal is already committed.
  assert.equal(seal.plan(ruleContext({
    snapshot: { currentTurnOrdinal: 1 }, episodes: after, sealedEpisodeIds: [],
  })), null, "a false negative fact is still planned after the late hit");
  assert.equal(seal.plan(ruleContext({
    snapshot: { currentTurnOrdinal: 1 }, episodes: after, sealedEpisodeIds: sealedIds,
  })), null, "the committed seal was re-asserted after the late hit");
});
