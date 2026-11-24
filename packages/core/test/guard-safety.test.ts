import assert from "node:assert/strict";
import { test } from "node:test";
import { Guard } from "../src/guard/guard.js";
import type { ValidationCode, ValidationInput } from "../src/guard/types.js";
import type { RulePlan } from "../src/rules/types.js";
import type { MessageNode, SessionSnapshot, ToolResultNode } from "../src/types/transcript.js";
import { unitIdFor } from "../src/units/tracker.js";
import { sha256Sync } from "../src/util/hash.js";
import { entry, ledger, message, pruneEvent, result, seal } from "./guard-fixtures.js";

function guard(): Guard {
  return new Guard({ ledger: ledger(), initialState: { consecutiveValidationFailures: 0, disabled: false } });
}

/**
 * A refusal streak of one: the same valid plan with one operation kind no check
 * accepts. The stale base revision this used to forge is no longer a refusal
 * (ISSUE-605: only the removal span's node identities are compared).
 */
function refusedPlan(value: ValidationInput): ValidationInput {
  return { ...value, plans: value.plans.map(p => ({ ...p,
    operations: [{ kind: "not-an-op" }] as unknown as typeof p.operations })) };
}

/**
 * A row that asks for exactly one message role. The unit id is computed for a
 * message node on purpose: ADR-0020 says no unit exists for it, so the guard
 * must answer `unknown-unit` — the refusal is scope's, not protection's.
 */
function roleRow(role: MessageNode["role"]): ValidationInput {
  const v = entry();
  const node = message({ role, id: "target", toolCallIds: [] });
  const s: SessionSnapshot = { ...v.snapshot, nodes: [node, message()] };
  const unitId = unitIdFor(s.sessionId, node as unknown as ToolResultNode, {
    byteRange: { startByte: 0, endByteExclusive: node.byteLength },
    lineRange: { startLine: 1, endLineInclusive: 1 },
  });
  return { ...v, snapshot: s, plans: [],
    input: pruneEvent([{ unitId, action: "forgetall", summary: "agent output", answeredInRound: 1 }]) };
}

interface ShapeRow {
  readonly row: string;
  readonly fixture: () => ValidationInput;
  /** The exact refusal codes the row raises, sorted; `[]` means the row is accepted. */
  readonly codes: readonly ValidationCode[];
}

/**
 * The snapshot- and plan-level safety rows: each breaks one assumption the
 * guard must not make, and `[]` marks the honest shapes that must pass.
 */
const SAFETY_ROWS: readonly ShapeRow[] = [
  {
    // ISSUE-058 chunk P3a; ADR-0022 §2: the host writes the result before
    // RACOONS sees the entry event, so a snapshot already carrying that result
    // under its own id is the NORMAL case, not a duplicate node.
    row: "land-first: the snapshot already holds the entry result",
    fixture: () => {
      const v = entry();
      return { ...v, plans: [], snapshot: { ...v.snapshot, nodes: [message(), result()] } };
    },
    codes: [],
  },
  {
    row: "a snapshot that repeats a node id on its own",
    fixture: () => {
      const v = entry();
      return { ...v, plans: [], snapshot: { ...v.snapshot, nodes: [message(), result(), result()] } };
    },
    codes: ["adjacency-changed", "pairing-changed"],
  },
  ...(["system", "developer", "user", "assistant"] as const).map(role => ({
    row: `a message carrying role ${role}`,
    fixture: () => roleRow(role),
    codes: ["unknown-unit"] as const,
  })),
  {
    row: "a plan whose ruleId is an accessor",
    fixture: () => {
      // The refusal must not run the getter: reading it is what a draft would
      // do, and the guard copies the input before it reads anything.
      accessorRead = false;
      const v = entry();
      const plan = { ...v.plans[0] };
      Object.defineProperty(plan, "ruleId", {
        enumerable: true, get: () => { accessorRead = true; return "cap"; },
      });
      return { ...v, plans: [plan as NonNullable<typeof v.plans[0]>] };
    },
    codes: ["invalid-plan"],
  },
];

/** Set by the accessor row's own getter; a guard that runs the getter flips it. */
let accessorRead = false;

test("snapshot and plan rows: every broken row is refused by name, the honest rows pass", async () => {
  for (const row of SAFETY_ROWS) {
    const value = row.fixture();
    const validation = await guard().validate(value);
    if (row.codes.length === 0) {
      assert.equal(validation.ok, true,
        `row: ${row.row} — the honest shape was refused: ${JSON.stringify(validation.ok ? [] : validation.issues)}`);
      continue;
    }
    assert.equal(validation.ok, false, `row: ${row.row} — the broken row was accepted`);
    if (validation.ok) continue;
    assert.deepEqual([...new Set(validation.issues.map(issue => issue.code))].sort(), [...row.codes].sort(),
      `row: ${row.row} — refused with the wrong codes: ${JSON.stringify(validation.issues)}`);
    assert.equal("application" in validation, false,
      `row: ${row.row} — a refused batch ships no application`);
    if (row.row === "a plan whose ruleId is an accessor") {
      assert.equal(accessorRead, false,
        `row: ${row.row} — the guard executed the plan's accessor instead of refusing it unread`);
    }
  }
});

test("the breaker quiets after the limit, re-arms on a completed validation, and concurrent refusals cannot race past breaker-disabled", async () => {
  const g = guard(), v = seal(), invalid = refusedPlan(v);

  await g.validate(invalid);
  assert.equal(g.state().consecutiveValidationFailures, 1, "row: one refusal — the streak is one");

  // An all-keepall window plans nothing; it is still a completed validation.
  await g.recordNoPlan();
  assert.equal(g.state().consecutiveValidationFailures, 0,
    "row: a keep-only pass — it ends the streak, an empty plan is a success");

  await g.validate(invalid); await g.validate(invalid);
  assert.equal(g.state().disabled, true, "row: two refusals — the breaker is quiet");

  // The quiet is per-ask: the next completed validation re-arms the breaker.
  await g.recordNoPlan();
  assert.deepEqual(g.state(), { consecutiveValidationFailures: 0, disabled: false },
    "row: a completed validation after the quiet — the disable expires (ISSUE-057)");
  assert.equal((await g.validate(v)).ok, true,
    "row: a real application after the quiet — it passes again");

  // recordNoPlan is queued like a validation, so a refusal cannot be overtaken.
  const queued = guard(), w = seal(), bad = refusedPlan(w);
  const [refusal, noPlan, valid] = await Promise.all(
    [queued.validate(bad), queued.recordNoPlan(), queued.validate(w)]);
  assert.equal(refusal.ok, false, "row: queued — one refusal is refused");
  assert.equal(valid.ok, true, "row: queued — the clean pass after the reset applies");
  assert.deepEqual(queued.state(), { consecutiveValidationFailures: 0, disabled: false },
    "row: queued — one refusal, then a reset, then a clean pass: order is the queue's");
  assert.equal(noPlan, undefined, "row: queued — recordNoPlan writes no ledger event");

  // The race: two concurrent refusals must reach the quiet one at a time.
  const raced = guard(), base = entry(), stale = refusedPlan(base);
  const [first, second, third] = await Promise.all(
    [raced.validate(stale), raced.validate(stale), raced.validate(base)]);
  assert.equal(first.breaker.consecutiveValidationFailures, 1,
    "row: raced — the first refusal counts one");
  assert.equal(second.breaker.disabled, true,
    "row: raced — the second refusal reaches the limit, never past it");
  assert.equal(third.ok, false, "row: raced — the third validation is refused while quiet");
  if (!third.ok) {
    assert.ok(third.issues.some(i => i.code === "breaker-disabled"),
      `row: breaker-disabled — the refusal while quiet must name it, got ${JSON.stringify(third.issues.map(i => i.code))}`);
  }
});

test("a genuine source-hash mismatch still counts: two refusals disable the breaker (ISSUE-188)", async () => {
  // The mount filters stale rows before the engine so they never reach the
  // guard (ISSUE-188). This pins the other half: an input that genuinely
  // reaches the guard with bytes that do not match its claim is still an
  // application failure, and two of them still quiet the breaker. The filter
  // must not be moved into the guard or shadow a real mismatch.
  const value = entry();
  const changedBytes = new TextEncoder().encode("a body the plan did not name");
  const changed = result({ bytes: changedBytes, sha256: sha256Sync(changedBytes),
    byteLength: changedBytes.length });
  const mismatched: ValidationInput = { ...value,
    snapshot: { ...value.snapshot, nodes: [message(), changed] } };
  const g = guard();
  const first = await g.validate(mismatched);
  assert.equal(first.ok, false, "row: a hash mismatch — it is refused");
  if (!first.ok) {
    assert.ok(first.issues.some(issue => issue.code === "source-hash-mismatch"),
      `row: a hash mismatch — the refusal names it, got ${JSON.stringify(first.issues.map(i => i.code))}`);
    assert.equal(first.breaker.consecutiveValidationFailures, 1, "row: the first refusal counts one");
  }
  const second = await g.validate(mismatched);
  assert.equal(second.ok, false, "row: the second mismatch is refused too");
  assert.equal(second.breaker.disabled, true, "row: two genuine application failures quiet the breaker");
});

test("a replace-mode seal stays refused, and the refusal names the missing seam", async () => {
  // ADR-0018 §4–5: a replace seal is not a proof in PRD §6.6, so it does not get
  // the proof lane. The refusal says which seam would have to be declared first;
  // it never claims the product has no way to apply a removal at all.
  const node = result();
  const removal = { id: "body", title: "Body", sources: [{ source: { nodeId: node.id,
    sha256: node.sha256, byteLength: node.byteLength },
  ranges: [{ startByte: 0, endByteExclusive: node.byteLength }] }] };
  const plan: RulePlan = { ruleId: "seal", baseRevision: "revision", removals: [removal],
    notes: [{ kind: "negative-fact", id: "marker", episodeId: "episode" }],
    operations: [{ kind: "seal", mode: "replace", removalId: "body", episodeId: "episode",
      noteId: "marker" }] };
  const validation = await guard().validate({ ...entry(), plans: [plan] });
  assert.equal(validation.ok, false, "row: replace seal — it must stay refused");
  if (!validation.ok) {
    const refusal = validation.issues.find(issue => issue.code === "unsupported-capability");
    assert.ok(refusal !== undefined,
      `row: replace seal — the refusal must name unsupported-capability, got ${JSON.stringify(validation.issues)}`);
    assert.ok(refusal.detail.endsWith("requires the programmatic revert seam"), refusal.detail);
    assert.equal(refusal.detail.includes("no application path"), false,
      "row: replace seal — the refusal names the seam, not an absence of any path");
  }
  assert.equal("application" in validation, false,
    "row: replace seal — a refused batch ships no application");
});
