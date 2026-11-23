import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseRevertCut, freedBytesOf, revertCost } from "../src/revert/cost.js";
import { chooseRevert, planRevertApplication } from "../src/revert/plan.js";
import type {
  RevertChoice, RevertCost, RevertInput, RevertItem, RevertPlan,
} from "../src/revert/types.js";

/**
 * One transcript entry. `id` (the entry key) and `nodeId` (the node it names)
 * differ on purpose: a planner reading the wrong one fails the anchor tests.
 */
function item(index: number, byteLength: number): RevertItem {
  return { id: `entry-${index}`, nodeId: `node-${index}`, byteLength };
}

/**
 * A partially kept entry: it frees only the bytes its removal drops
 * (`freedByteLength`) and the rest stays in the request (ISSUE-509).
 */
function partialItem(index: number, byteLength: number, freedByteLength: number): RevertItem {
  return { ...item(index, byteLength), freedByteLength };
}

/** Every receipt costs the same in these fixtures, so hand arithmetic stays exact. */
const RECEIPT = 200;
const fixedReceipt = (): number => RECEIPT;

/**
 * The doc's own numbers (design-protocol §2): one 400-byte forgotten unit at
 * index 3, 60 kB of kept suffix plus 1 kB behind it, nothing else forgotten.
 *
 *   0..2   500 kept each
 *   3      400 forgotten
 *   4..9   10 000 kept each    (= 60 kB)
 *   12     1 000 kept
 */
function docNarrative(): readonly RevertItem[] {
  return [
    item(0, 500), item(1, 500), item(2, 500),
    item(3, 400),
    item(4, 10_000), item(5, 10_000), item(6, 10_000),
    item(7, 10_000), item(8, 10_000), item(9, 10_000),
    item(10, 1_000),
  ];
}

/**
 * A scaled §2 fixture where the early cut loses and a later cluster wins:
 *
 *   0..2   500 kept each
 *   3      400 forgotten        <- the early small cut
 *   4..9   10 000 kept each     <- 60 kB of kept suffix
 *   10     30 000 forgotten     <- the dense cluster
 *   11     30 000 forgotten
 *   12     1 000 kept
 */
function earlySmallVersusLateCluster(): readonly RevertItem[] {
  return [
    item(0, 500), item(1, 500), item(2, 500),
    item(3, 400),
    item(4, 10_000), item(5, 10_000), item(6, 10_000),
    item(7, 10_000), item(8, 10_000), item(9, 10_000),
    item(10, 30_000), item(11, 30_000),
    item(12, 1_000),
  ];
}

const EARLY_CLUSTER_FORGOTTEN: ReadonlySet<number> = new Set([3, 10, 11]);

function inputOf(
  nodes: readonly RevertItem[],
  forgotten: ReadonlySet<number>,
  overrides: Partial<RevertInput> = {},
): RevertInput {
  return {
    nodes,
    forgotten,
    freshStart: 0,
    receiptBytes: fixedReceipt,
    minCutFreedBytes: 10_000,
    ...overrides,
  };
}

function mustChoose(input: RevertInput): RevertChoice {
  const choice = chooseRevertCut(input);
  assert.ok(choice !== null, "expected a chosen cut");
  return choice;
}

function costOf(
  nodes: readonly RevertItem[],
  forgotten: ReadonlySet<number>,
  cutIndex: number,
  receiptBytes: (index: number) => number = fixedReceipt,
): RevertCost {
  return revertCost({ nodes, forgotten, cutIndex, receiptBytes });
}

// --- the §2 net-freed formula ------------------------------------------------

interface CostRow {
  readonly name: string;
  readonly nodes: readonly RevertItem[];
  readonly forgotten: ReadonlySet<number>;
  readonly cutIndex: number;
  readonly expect: RevertCost;
}

/**
 * The formula itself, one row per cut worth pinning: the doc's own example, a
 * cut that clears the freed floor and still loses on net, and the cut the same
 * fixture prefers. Each row is hand arithmetic, so a rewritten sum names itself.
 */
const COST_ROWS: readonly CostRow[] = [
  {
    // freed(3) = 400; kept(3) = 60 000 + 1 000 = 61 000; receipt(3) = 200.
    // The doc writes "400 − 61 000 < 0"; the receipt term is in the formula, so
    // the exact value is 400 − 61 000 − 200 = −60 800.
    name: "the doc's own §2 example: one forgotten unit buys a 61 kB re-send",
    nodes: docNarrative(),
    forgotten: new Set([3]),
    cutIndex: 3,
    expect: {
      cutIndex: 3, freedBytes: 400, keptBytes: 61_000, receiptBytes: 200, netFreedBytes: -60_800,
    },
  },
  {
    // freed(3) = 400 + 30 000 + 30 000 = 60 400 — it clears the freed floor.
    //   kept(3)    = 60 000 + 1 000 = 61 000
    //   receipt(3) = 3 × 200 = 600
    //   net(3)     = −1 200
    name: "a cut whose freed bytes clear the floor can still net negative",
    nodes: earlySmallVersusLateCluster(),
    forgotten: EARLY_CLUSTER_FORGOTTEN,
    cutIndex: 3,
    expect: {
      cutIndex: 3, freedBytes: 60_400, keptBytes: 61_000, receiptBytes: 600, netFreedBytes: -1_200,
    },
  },
  {
    // freed(10) = 30 000 + 30 000 = 60 000; kept(10) = 1 000; receipt(10) = 400.
    name: "the later cluster is positive: 60 000 freed, 1 000 kept, 400 receipts",
    nodes: earlySmallVersusLateCluster(),
    forgotten: EARLY_CLUSTER_FORGOTTEN,
    cutIndex: 10,
    expect: {
      cutIndex: 10, freedBytes: 60_000, keptBytes: 1_000, receiptBytes: 400, netFreedBytes: 58_600,
    },
  },
];

test("the §2 cost table — one row per cut, hand arithmetic", () => {
  for (const row of COST_ROWS) {
    assert.deepEqual(costOf(row.nodes, row.forgotten, row.cutIndex), row.expect, `row: ${row.name}`);
  }
});

// --- a partial keep (ISSUE-509) ----------------------------------------------

test("a partial keep frees only its dropped ranges and keeps the remainder in the request", () => {
  // A 1 000-byte unit answered `keeplines` over all but one line: 250 bytes are
  // dropped, 750 stay in the request beside the 3 000-byte survivor.
  const nodes = [item(0, 500), partialItem(1, 1_000, 250), item(2, 3_000)];
  assert.deepEqual(costOf(nodes, new Set([1]), 1), {
    cutIndex: 1, freedBytes: 250, keptBytes: 750 + 3_000, receiptBytes: RECEIPT,
    netFreedBytes: 250 - 3_750 - RECEIPT,
  }, "row: partial keep — the kept lines are not a saving and they are paid again");
});

test("a whole-node removal prices exactly as it did before the partial-keep fix", () => {
  // `freedByteLength` absent (every pre-existing caller) and set to the node's
  // own length must be one cost, field for field.
  const whole = [item(0, 500), item(1, 1_000), item(2, 3_000)];
  const explicit = [item(0, 500), partialItem(1, 1_000, 1_000), item(2, 3_000)];
  assert.deepEqual(costOf(explicit, new Set([1]), 1), costOf(whole, new Set([1]), 1),
    "row: an explicit whole-node free is the default");
  assert.deepEqual(costOf(whole, new Set([1]), 1), {
    cutIndex: 1, freedBytes: 1_000, keptBytes: 3_000, receiptBytes: RECEIPT,
    netFreedBytes: 1_000 - 3_000 - RECEIPT,
  }, "row: the whole node is freed and nothing of it is kept");
});

test("a removal that drops no bytes frees nothing and the chooser refuses its cut", () => {
  const nodes = [item(0, 500), partialItem(1, 1_000, 0), item(2, 3_000)];
  assert.deepEqual(costOf(nodes, new Set([1]), 1), {
    cutIndex: 1, freedBytes: 0, keptBytes: 1_000 + 3_000, receiptBytes: RECEIPT,
    netFreedBytes: -4_000 - RECEIPT,
  }, "row: an empty drop frees zero and keeps the whole node");
  assert.equal(chooseRevertCut(inputOf(nodes, new Set([1]), { minCutFreedBytes: 0 })), null,
    "row: a cut that frees nothing never wins, even with the floor removed");
});

test("the freed bytes of one removal are the sum of its dropped ranges", () => {
  // The dropped span of the guard's four-line fixture (lines 2–3), then two
  // disjoint spans.
  assert.equal(freedBytesOf([{ startByte: 7, endByteExclusive: 24 }]), 17);
  assert.equal(freedBytesOf([
    { startByte: 0, endByteExclusive: 3 }, { startByte: 10, endByteExclusive: 15 },
  ]), 8);
  assert.equal(freedBytesOf([]), 0, "no ranges drop no bytes");
  assert.throws(() => freedBytesOf([{ startByte: 5, endByteExclusive: 4 }]),
    /must not run backwards/, "an inverted range must be named, not summed");
  assert.throws(() => revertCost({
    nodes: [partialItem(0, 100, 101)], forgotten: new Set([0]), cutIndex: 0,
    receiptBytes: () => 0,
  }), /frees 101 of its 100 bytes/, "a free larger than the node must be named");
});

// --- selection: which prefix node is cut -------------------------------------

interface SelectionProbe {
  readonly floor: number;
  readonly freshStart?: number;
  /** The prefix node the chooser must cut, or `null` when nothing wins. */
  readonly cutIndex: number | null;
  readonly cost?: RevertCost;
}

interface SelectionRow {
  readonly name: string;
  readonly nodes: readonly RevertItem[];
  readonly forgotten: ReadonlySet<number>;
  readonly receiptBytes?: (index: number) => number;
  readonly probes: readonly SelectionProbe[];
  /** A cut that frees more bytes than the winner and still loses on net. */
  readonly loserIndex?: number;
  /** Another cut that scores the same net, proving a tie is really a tie. */
  readonly tieWithIndex?: number;
}

/**
 * Which prefix node is cut, one row per selection rule. `freedBytes`-maximal is
 * never the answer: the net term is what selects, the floor only gates, a tie
 * keeps the smaller index, and a candidate at the fresh-zone watermark is the
 * first one allowed.
 */
const SELECTION_ROWS: readonly SelectionRow[] = [
  {
    // Cut 3 clears the freed floor (60 400 ≥ 10 000) and loses on net alone; a
    // chooser ranking by freed bytes would pick index 3 here.
    name: "an early small cut loses and the later dense cluster wins the cut",
    nodes: earlySmallVersusLateCluster(),
    forgotten: EARLY_CLUSTER_FORGOTTEN,
    probes: [{ floor: 10_000, cutIndex: 10, cost: {
      cutIndex: 10, freedBytes: 60_000, keptBytes: 1_000, receiptBytes: 400, netFreedBytes: 58_600,
    } }],
    loserIndex: 3,
  },
  {
    // The floor rejects it first (freed = 400 < 10 000) …
    // … and with the floor at zero the net filter is the one that refuses it.
    name: "a cut with a non-positive net is refused even with the freed floor removed",
    nodes: earlySmallVersusLateCluster(),
    forgotten: new Set([3]),
    probes: [{ floor: 10_000, cutIndex: null }, { floor: 0, cutIndex: null }],
  },
  {
    // net(1) = (500 + 5 000 + 9 000) − (400 + 1 000) − 3 × 100 = 12 800
    // net(3) = (5 000 + 9 000)        − 1 000         − 2 × 100 = 12 800
    // Node 0 is before both cuts and enters neither sum.
    name: "a tie on netFreedBytes picks the smaller cut index",
    nodes: [
      item(0, 2_000), item(1, 500), item(2, 400),
      item(3, 5_000), item(4, 1_000), item(5, 9_000),
    ],
    forgotten: new Set([1, 3, 5]),
    receiptBytes: () => 100,
    probes: [{ floor: 5_000, cutIndex: 1, cost: {
      cutIndex: 1, freedBytes: 14_500, keptBytes: 1_400, receiptBytes: 300, netFreedBytes: 12_800,
    } }],
    tieWithIndex: 3,
  },
  {
    // freed(1) = 1 000 and net(1) = 1 000 − 500 − 100 = 400 > 0: only the floor
    // rejects this candidate, so this row fails exactly when the floor is gone.
    name: "a cut freeing less than minCutFreedBytes is rejected, and exactly the floor passes",
    nodes: [item(0, 500), item(1, 1_000), item(2, 500)],
    forgotten: new Set([1]),
    receiptBytes: () => 100,
    probes: [
      { floor: 1_001, cutIndex: null },
      { floor: 1_000, cutIndex: 1, cost: {
        cutIndex: 1, freedBytes: 1_000, keptBytes: 500, receiptBytes: 100, netFreedBytes: 400,
      } },
    ],
  },
];

test("cut selection — one row per rule, and the same answer on every run", () => {
  for (const row of SELECTION_ROWS) {
    const receiptBytes = row.receiptBytes ?? fixedReceipt;
    for (const probe of row.probes) {
      const rowName = `${row.name} @ floor ${String(probe.floor)}`;
      const input = inputOf(row.nodes, row.forgotten,
        { receiptBytes, minCutFreedBytes: probe.floor, freshStart: probe.freshStart ?? 0 });
      const choice = chooseRevertCut(input);
      assert.deepEqual(choice, chooseRevert(input), `row: ${rowName} — plan.ts aliases the same chooser`);
      if (probe.cutIndex === null) {
        assert.equal(choice, null, `row: ${rowName} — a cut was chosen where none should win`);
        continue;
      }
      assert.ok(choice !== null, `row: ${rowName} — no cut was chosen`);
      assert.equal(choice.cutIndex, probe.cutIndex, `row: ${rowName} — wrong prefix node cut`);
      if (probe.cost !== undefined) {
        assert.deepEqual(choice.cost, probe.cost, `row: ${rowName} — wrong cost for the chosen cut`);
      }
      // Determinism is one of the chosen cut's own promises.
      assert.deepEqual(chooseRevertCut(input), choice, `row: ${rowName} — the same input changed answer`);

      if (row.loserIndex !== undefined) {
        const loser = costOf(row.nodes, row.forgotten, row.loserIndex, receiptBytes);
        assert.ok(loser.freedBytes > choice.cost.freedBytes,
          `row: ${rowName} — the loser must free more, or net is not what selected`);
        assert.ok(loser.netFreedBytes < 0, `row: ${rowName} — the loser must still lose on net`);
      }
      if (row.tieWithIndex !== undefined) {
        const rival = costOf(row.nodes, row.forgotten, row.tieWithIndex, receiptBytes);
        assert.equal(rival.netFreedBytes, choice.cost.netFreedBytes,
          `row: ${rowName} — the tie is real, not a typo`);
      }
    }
  }
});

/**
 * The live shape from ISSUE-083, with the run's own numbers: two 1 000 B prefix
 * nodes, one 18 292 B forgotten node, one 18 292 B survivor, a 204 B receipt.
 *
 * `netFreedBytes` is the one-request transaction: the freed span leaves, the
 * whole kept suffix is re-sent once, the receipt is generated. The standing
 * delta is freed − receipt = +18 088 B on every later request, so −204 here is
 * expected, not a defect — a verdict's dictated cut applies unconditionally
 * (ADR-0012) and is not the chooser's to refuse. The full-revisit chooser still
 * refuses the same cut at a zero freed floor: its positive-net filter selects a
 * cut, it does not audit one.
 */
test("the live 18 KiB swap prices one request at -204 and the chooser still refuses it", () => {
  const nodes = [item(0, 1_000), item(1, 1_000), item(2, 18_292), item(3, 18_292)];
  const forgotten: ReadonlySet<number> = new Set([2]);
  const cost = revertCost({ nodes, forgotten, cutIndex: 2, receiptBytes: () => 204 });
  assert.deepEqual(cost, {
    cutIndex: 2, freedBytes: 18_292, keptBytes: 18_292, receiptBytes: 204, netFreedBytes: -204,
  }, "row: the live swap prices one request");
  assert.equal(cost.freedBytes - cost.receiptBytes, 18_088,
    "row: the standing delta per later request");
  const standIn = inputOf(nodes, forgotten, { receiptBytes: () => 204, minCutFreedBytes: 0 });
  assert.equal(chooseRevertCut(standIn), null,
    "row: the chooser refuses what a verdict may dictate");
});

// --- candidates the scan may not reach ---------------------------------------

interface CandidateRow {
  readonly name: string;
  readonly nodes: readonly RevertItem[];
  readonly forgotten: ReadonlySet<number>;
  readonly probes: readonly SelectionProbe[];
}

/**
 * The candidate set is `{ i ∈ forgotten | i ≥ freshStart }`. A row's positive
 * probe sits at the watermark itself, so a scan that refused everything would
 * fail its own control.
 */
const CANDIDATE_ROWS: readonly CandidateRow[] = [
  {
    name: "an empty forgotten set",
    nodes: earlySmallVersusLateCluster(),
    forgotten: new Set<number>(),
    probes: [{ floor: 0, cutIndex: null }],
  },
  {
    name: "a forgotten index below the fresh zone",
    nodes: [item(0, 1_000), item(1, 1_000), item(2, 5_000), item(3, 100)],
    forgotten: new Set([1, 2]),
    probes: [
      { floor: 0, freshStart: 3, cutIndex: null },
      { floor: 0, freshStart: 2, cutIndex: 2 },
    ],
  },
];

test("candidates outside the forgotten set or below the fresh zone are never cut", () => {
  for (const row of CANDIDATE_ROWS) {
    for (const probe of row.probes) {
      const rowName = `${row.name} @ freshStart ${String(probe.freshStart ?? 0)}`;
      const choice = chooseRevertCut(inputOf(row.nodes, row.forgotten,
        { minCutFreedBytes: probe.floor, freshStart: probe.freshStart ?? 0 }));
      const actual = choice === null ? null : choice.cutIndex;
      assert.equal(actual, probe.cutIndex, `row: ${rowName} — wrong prefix node cut`);
    }
  }
});

// --- planning ----------------------------------------------------------------

/** Cut 2 wins; its two receipts anchor differently: at the head, then after node-3. */
function anchorFixture(): readonly RevertItem[] {
  return [
    item(0, 100), item(1, 100),
    item(2, 2_000),
    item(3, 100),
    item(4, 3_000),
    item(5, 100),
  ];
}

function mustPlan(input: Parameters<typeof planRevertApplication>[0]): RevertPlan {
  const plan = planRevertApplication(input);
  assert.ok(plan !== null, "expected a plan");
  return plan;
}

interface PlanningRow {
  readonly name: string;
  readonly nodes: readonly RevertItem[];
  readonly forgotten: ReadonlySet<number>;
  readonly cutIndex: number;
  readonly cost: RevertCost;
  readonly survivors: readonly string[];
  readonly appends: readonly { readonly afterNodeId: string | null; readonly noteId: string }[];
}

/**
 * Where the receipts land, one row per anchor case: a cut with a salvageable
 * prefix anchors its first receipt at the prefix tail, a cut at the transcript
 * head has nothing before it and anchors there. Both name `nodeId`, never the
 * entry `id` (the fixtures differ).
 */
const PLANNING_ROWS: readonly PlanningRow[] = [
  {
    // net(2) = (2 000 + 3 000) − (100 + 100) − 200 = 4 600
    // net(4) = 3 000 − 100 − 100 = 2 800
    name: "a plan carries the chosen cut, survivors in order and receipts at their anchors",
    nodes: anchorFixture(),
    forgotten: new Set([2, 4]),
    cutIndex: 2,
    cost: { cutIndex: 2, freedBytes: 5_000, keptBytes: 200, receiptBytes: 200, netFreedBytes: 4_600 },
    survivors: ["node-3", "node-5"],
    // No survivor precedes the cut node, so the first receipt anchors at the
    // prefix tail — never at the transcript head, which would put a receipt
    // before the salvage §4 leaves untouched. The second anchors at node-3.
    appends: [
      { afterNodeId: "node-1", noteId: "receipt:2" },
      { afterNodeId: "node-3", noteId: "receipt:4" },
    ],
  },
  {
    // net(0) = (5 000 + 3 000) − (100 + 100) − 200 = 7 600
    // net(2) = 3 000 − 100 − 100                    = 2 800
    // Cut 0 wins, so no prefix exists and the head is the only anchor left.
    name: "a cut at the transcript head anchors its first receipt at the head",
    nodes: [item(0, 5_000), item(1, 100), item(2, 3_000), item(3, 100)],
    forgotten: new Set([0, 2]),
    cutIndex: 0,
    cost: { cutIndex: 0, freedBytes: 8_000, keptBytes: 200, receiptBytes: 200, netFreedBytes: 7_600 },
    survivors: ["node-1", "node-3"],
    appends: [
      { afterNodeId: null, noteId: "receipt:0" },
      { afterNodeId: "node-1", noteId: "receipt:2" },
    ],
  },
];

test("planning — one row per anchor case, the chosen cut carried through", () => {
  for (const row of PLANNING_ROWS) {
    const plan = mustPlan({
      nodes: row.nodes,
      forgotten: row.forgotten,
      freshStart: 0,
      receiptBytes: () => 100,
      minCutFreedBytes: 0,
      baseRevision: "revision-9",
      noteId: index => `receipt:${index}`,
    });
    assert.equal(plan.cutIndex, row.cutIndex, `row: ${row.name} — wrong prefix node cut`);
    assert.deepEqual(plan.cost, row.cost, `row: ${row.name} — wrong cost on the plan`);
    assert.deepEqual(plan.survivors, row.survivors, `row: ${row.name} — wrong survivors`);
    assert.deepEqual(plan.appends, row.appends, `row: ${row.name} — wrong receipt anchors`);
    assert.equal(plan.baseRevision, "revision-9", `row: ${row.name} — wrong base revision`);
  }
});

// --- stale forgotten indices (ISSUE-322) -------------------------------------

test("an out-of-range forgotten index is a named error, never silently ignored (ISSUE-322)", () => {
  const nodes = [item(0, 100), item(1, 5_000), item(2, 100)];
  // After a truncation the old list's index 5 no longer exists.
  assert.throws(
    () => chooseRevertCut(inputOf(nodes, new Set([5]), { minCutFreedBytes: 0 })),
    /Forgotten index 5 is outside the transcript/,
    "an out-of-range forgotten index must surface a named error",
  );
  assert.throws(
    () => chooseRevertCut(inputOf(nodes, new Set([-1]), { minCutFreedBytes: 0 })),
    /Forgotten index -1 is outside the transcript/,
    "a negative forgotten index must surface a named error",
  );
  assert.throws(
    () => chooseRevertCut(inputOf(nodes, new Set([1.5]), { minCutFreedBytes: 0 })),
    /Forgotten index 1.5 is outside the transcript/,
    "a non-integer forgotten index must surface a named error",
  );
});

test("a shifted forgotten index naming a different node is detected (ISSUE-322)", () => {
  const nodes = [item(0, 100), item(1, 5_000), item(2, 100)];
  // The stale set meant node-2, which now sits at index 2; index 1 holds node-1.
  const stale = inputOf(nodes, new Set([1]), {
    minCutFreedBytes: 0,
    forgottenNodeIds: new Map([[1, "node-2"]]),
  });
  assert.throws(
    () => chooseRevertCut(stale),
    /Forgotten index 1 names node-1, not the declared node-2/,
    "a shifted index marking a different node must surface a named error",
  );
  // A forgotten index with no declared identity is refused when identities are given.
  assert.throws(
    () => chooseRevertCut(inputOf(nodes, new Set([1]), {
      minCutFreedBytes: 0, forgottenNodeIds: new Map([[2, "node-2"]]),
    })),
    /Forgotten index 1 has no declared node identity/,
    "an undeclared identity for a forgotten index must surface a named error",
  );
  // The control: a matching identity still chooses the cut (the check never over-rejects).
  const choice = chooseRevertCut(inputOf(nodes, new Set([1]), {
    minCutFreedBytes: 0, forgottenNodeIds: new Map([[1, "node-1"]]),
  }));
  assert.ok(choice !== null, "a matching identity must still choose the cut");
  assert.equal(choice.cutIndex, 1, "the matching-identity control cuts index 1");
});
