import assert from "node:assert/strict";
import { test } from "node:test";
import { SealRule } from "../src/rules/seal.js";
import type { Episode } from "../src/episodes/types.js";
import type { RuleContext } from "../src/rules/types.js";
import { episode, ruleContext, pathEvidence, ruleConfig } from "./rules-fixtures.js";

const rule = new SealRule();

type Fixture = Parameters<typeof ruleContext>[0];

/**
 * The plan the rule assembles, one row per case. Every row is a plan, not a
 * skip: what a sealed episode becomes on the transcript — one append per timely
 * episode, one negative fact per append, and no removal at all.
 */
const PLAN_ROWS: readonly {
  readonly name: string;
  readonly episodes: readonly Episode[];
  readonly fixture?: Omit<Fixture, "episodes">;
  readonly operations: readonly object[];
  readonly noteIds: readonly string[];
}[] = [
  {
    name: "one episode: one append, one negative fact, zero removals",
    episodes: [episode()],
    operations: [{
      kind: "seal", mode: "append", episodeId: "episode-1", removalId: null,
      noteId: "episode:episode-1",
    }],
    noteIds: ["episode:episode-1"],
  },
  {
    // Unknown evidence beside the misses is still sealed, and neither result is
    // removed: the note, not a removal, is how an episode is recorded.
    name: "misses seal beside unknown evidence without removing either result",
    episodes: [episode({
      memberNodeIds: ["result-1", "unknown-1"],
      unknownNodeIds: ["unknown-1"],
      paths: [pathEvidence(), pathEvidence({ displayPath: "unknown.ts", outcome: "unknown" })],
    })],
    operations: [{
      kind: "seal", mode: "append", episodeId: "episode-1", removalId: null,
      noteId: "episode:episode-1",
    }],
    noteIds: ["episode:episode-1"],
  },
  {
    // Timely episodes accumulate in transcript order; the late one is excluded
    // from the same pass rather than aborting it.
    name: "all timely episodes share one plan while the late one is excluded",
    episodes: [
      episode({ id: "late", closedAtTurn: 1 }),
      episode({ id: "first" }),
      episode({ id: "second", closedAtTurn: 3 }),
    ],
    operations: [
      { kind: "seal", mode: "append", episodeId: "first", removalId: null, noteId: "episode:first" },
      { kind: "seal", mode: "append", episodeId: "second", removalId: null, noteId: "episode:second" },
    ],
    noteIds: ["episode:first", "episode:second"],
  },
];

test("append seal — one row per plan shape, a note and never a removal", () => {
  for (const row of PLAN_ROWS) {
    const context = ruleContext({ ...(row.fixture ?? {}), episodes: row.episodes });
    const before = structuredClone(context);
    const plan = rule.plan(context);
    assert.ok(plan !== null, `row: ${row.name} — no plan where a seal was due`);
    assert.equal(plan.ruleId, "seal", `row: ${row.name} — wrong rule id`);
    assert.equal(plan.baseRevision, "revision-1", `row: ${row.name} — wrong base revision`);
    assert.deepEqual(plan.removals, [], `row: ${row.name} — a seal removes nothing`);
    assert.deepEqual(plan.operations, row.operations, `row: ${row.name} — wrong seal operations`);
    assert.deepEqual(plan.notes.map(note => ({ id: note.id, kind: note.kind })),
      row.noteIds.map(id => ({ id, kind: "negative-fact" })),
      `row: ${row.name} — wrong negative facts`);
    assert.deepEqual(context, before, `row: ${row.name} — planning mutated the context`);
  }
});

/**
 * Every clause that keeps an episode out of a seal, one row per claim. The
 * control at the top of the loop is the bare fixture, so a null below is the
 * row's own clause and not a broken fixture.
 */
interface SkipRow {
  readonly name: string;
  readonly episodes: readonly Episode[];
  readonly fixture?: Omit<Fixture, "episodes">;
}

/** An episode whose search succeeded has nothing to record as a negative fact. */
const SKIP_ROWS: readonly SkipRow[] = [
  { name: "an episode with a hit", episodes: [episode({ hitNodeIds: ["hit-1"] })] },
  { name: "a hit in path evidence", episodes: [episode({ paths: [pathEvidence({ outcome: "hit" })] })] },
  { name: "an episode with zero misses",
    episodes: [episode({ missNodeIds: [], unknownNodeIds: ["result-1"] })] },
  // One episode, one seal: a sealed id is never re-sealed.
  { name: "an already sealed episode", episodes: [episode()],
    fixture: { sealedEpisodeIds: ["episode-1"] } },
  // The episode must be closed and carry the turn it closed on.
  { name: "an open episode", episodes: [episode({
    status: "open", closedAtTurn: null, closedAtStep: null, closeReason: null })] },
  { name: "a closed episode with no closure turn", episodes: [episode({ closedAtTurn: null })] },
  // The clock is transcript order: a closure turn in the future is not late, it
  // is unreadable, and it is skipped by the same window.
  { name: "an episode closing after the current turn", episodes: [episode({ closedAtTurn: 4 })] },
  // Past the latency window the episode is too old for its negative fact to help.
  { name: "an episode past the latency window", episodes: [episode({ closedAtTurn: 2 })],
    fixture: { snapshot: { currentTurnOrdinal: 4 } } },
];

/**
 * The capability gate is a gate over the whole pass, not a clause over one
 * episode: the same episode seals under the full flags and not under either
 * missing one.
 */
const CAPABILITY_ROWS: readonly {
  readonly name: string;
  readonly capabilities: Partial<RuleContext["capabilities"]>;
}[] = [
  { name: "atRest false", capabilities: { atRest: false } },
  { name: "appendRecords false", capabilities: { appendRecords: false } },
];

test("episodes and passes outside the rule's claim are skipped, the control still seals", () => {
  const control = ruleContext({ episodes: [episode()] });
  assert.ok(rule.plan(control) !== null, "row: control — the bare episode must seal");
  for (const row of SKIP_ROWS) {
    const context = ruleContext({ ...(row.fixture ?? {}), episodes: row.episodes });
    assert.equal(rule.plan(context) === null, true, `row: ${row.name}`);
  }
  for (const row of CAPABILITY_ROWS) {
    assert.equal(rule.plan({ ...control, capabilities: { ...control.capabilities,
      ...row.capabilities } }), null, `row: ${row.name}`);
  }
});

test("zero-turn latency permits the closure turn and skips the next turn", () => {
  const fixture = {
    config: ruleConfig({ sealMaxLatencyTurns: 0 }),
    episodes: [episode({ closedAtTurn: 2 })],
  };
  assert.ok(rule.plan(ruleContext({ ...fixture, snapshot: { currentTurnOrdinal: 2 } })) !== null,
    "row: latency 0 at the closure turn — it must seal");
  assert.equal(rule.plan(ruleContext({ ...fixture, snapshot: { currentTurnOrdinal: 3 } })), null,
    "row: latency 0 one turn later — it must be skipped");
});
