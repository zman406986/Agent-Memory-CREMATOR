import assert from "node:assert/strict";
import { test } from "node:test";
import type { ForgetRequest } from "../src/engine/types.js";
import { checkForget } from "../src/guard/checks-forget.js";
import { checkInvalidation } from "../src/guard/checks-invalidation.js";
import { checkProofs } from "../src/guard/checks-proofs.js";
import { privateCopy } from "../src/guard/checks-shape.js";
import { Guard } from "../src/guard/guard.js";
import { LedgerError } from "../src/ledger/types.js";
import type { Operation, Removal, RulePlan } from "../src/rules/types.js";
import type { ValidationCode, ValidationInput } from "../src/guard/types.js";
import { capPlan, context, entry, ledger, message, ref, result, seal } from "./guard-fixtures.js";

const guard = (): Guard => new Guard({ ledger: ledger(), initialState: { consecutiveValidationFailures: 0, disabled: false } });
function planOf(v: ValidationInput): RulePlan { const p = v.plans[0]; if (!p) throw new Error("No plan"); return p; }
function removalOf(p: RulePlan): Removal { const r = p.removals[0]; if (!r) throw new Error("No removal"); return r; }
function replan(v: ValidationInput, p: Partial<RulePlan>): ValidationInput { return { ...v, plans: [{ ...planOf(v), ...p }] }; }
function sourceChange(v: ValidationInput, change: Partial<typeof ref>): ValidationInput {
  const r = removalOf(planOf(v)), s = r.sources[0]; if (!s) throw new Error("No source");
  return replan(v, { removals: [{ ...r, sources: [{ ...s, source: { ...s.source, ...change } }] }] });
}
function ranges(v: ValidationInput, spans: readonly { startByte: number; endByteExclusive: number }[]): ValidationInput {
  const r = removalOf(planOf(v)), s = r.sources[0]; if (!s) throw new Error("No source");
  return replan(v, { removals: [{ ...r, sources: [{ ...s, ranges: spans }] }] });
}
function replaceSealOp(v: ValidationInput): ValidationInput {
  const p = planOf(v), original = p.operations[0];
  if (original?.kind !== "seal") throw new Error("No seal");
  return replan(v, { operations: [{ ...original, mode: "replace", removalId: "body" }],
    removals: [{ ...removalOf(capPlan()), sources: [{ source: ref, ranges: [{ startByte: 0, endByteExclusive: ref.byteLength }] }] }] });
}

/**
 * The plan-level refusals: each row breaks one claim of a plan that otherwise
 * validates, so a check that stopped reading would let the row through.
 */
const PLAN_CASES: readonly [ValidationCode, () => ValidationInput][] = [
  ["invalid-plan", () => replan(entry(), { operations: [{ kind: "not-an-op" }] as unknown as readonly Operation[] })],
  ["wrong-rule", () => replan(entry(), { ruleId: "seal" })],
  ["unknown-source", () => sourceChange(entry(), { nodeId: "missing" })],
  ["source-hash-mismatch", () => sourceChange(entry(), { sha256: "0".repeat(64) })],
  ["source-length-mismatch", () => sourceChange(entry(), { byteLength: ref.byteLength + 1 })],
  ["invalid-range", () => ranges(entry(), [{ startByte: -1, endByteExclusive: ref.byteLength }])],
  ["overlapping-removals", () => ranges(entry(), [
    { startByte: 6, endByteExclusive: ref.byteLength }, { startByte: 7, endByteExclusive: ref.byteLength },
  ])],
  ["conflicting-operations", () => { const v = entry(); return replan(v, { operations: [...planOf(v).operations, ...planOf(v).operations] }); }],
  ["unused-removal", () => replan(entry(), { operations: [] })],
  ["invalid-note", () => replan(entry(), { notes: [] })],
  ["invalid-generated-record", () => { const v = entry(); return { ...v, input: { kind: "entry", eventId: "event",
    result: result({ embeddedRecords: [{ startByte: 0, endByteExclusive: ref.byteLength + 1 }] }) } }; }],
];

/** The event- and snapshot-level refusals: the pair the plan sits beside. */
const EVENT_CASES: readonly [ValidationCode, () => ValidationInput][] = [
  ["outside-fresh-zone", () => { const v = entry(); return { ...v,
    input: { kind: "at-rest", eventId: "event", reason: "step" }, snapshot: { ...v.snapshot,
      nodes: [message(), result()], cache: { kind: "warm", watermarkNodeIndex: 2 } } }; }],
  ["pairing-changed", () => { const v = entry(); return { ...v,
    input: { kind: "entry", eventId: "event", result: result({ callId: "absent-call" }) } }; }],
  ["adjacency-changed", () => { const v = entry(); return { ...v, snapshot: { ...v.snapshot,
    nodes: [message(), message({ toolCallIds: [] })] } }; }],
  ["episode-open", () => { const v = seal(); return { ...v, snapshot: { ...v.snapshot, completedThroughTurnOrdinal: 0 } }; }],
  ["episode-evidence-missing", () => { const v = seal(); const p = planOf(v); return replan(v, {
    operations: [{ kind: "seal", mode: "append", episodeId: "absent", removalId: null, noteId: "fact" }],
    notes: [{ id: "fact", kind: "negative-fact", episodeId: "absent" }], baseRevision: p.baseRevision }); }],
  ["hit-removal", () => { const v = replaceSealOp(seal()), node = result(); return { ...v,
    snapshot: { ...v.snapshot, nodes: [message(), { ...node, evidence: { ...node.evidence,
      paths: node.evidence.paths.map(p => ({ ...p, outcome: "hit" as const })) } }] } }; }],
  ["late-seal", () => { const v = seal(); return { ...v, snapshot: { ...v.snapshot, currentTurnOrdinal: 3 } }; }],
  ["cold-boundary-required", () => { const v = entry(); return { ...v,
    snapshot: { ...v.snapshot, cache: { kind: "cold", boundary: { kind: "resume", observedAtMs: 11 } } } }; }],
];

async function assertRefused(code: ValidationCode, fixture: () => ValidationInput, row: string): Promise<void> {
  const validation = await guard().validate(fixture());
  assert.equal(validation.ok, false, `row: ${row} — the application was accepted`);
  if (validation.ok) return;
  assert.ok(validation.issues.some(issue => issue.code === code),
    `row: ${row} — expected ${code}, got ${JSON.stringify(validation.issues.map(issue => issue.code))}`);
  assert.equal("application" in validation, false, `row: ${row} — a refused batch ships no application`);
}

test("plan-level refusals — one code per row", async () => {
  for (const [code, fixture] of PLAN_CASES) await assertRefused(code, fixture, code);
});

test("event- and snapshot-level refusals — one code per row", async () => {
  for (const [code, fixture] of EVENT_CASES) await assertRefused(code, fixture, code);
});

test("wrong session rejects a reused guard", async () => {
  const g = guard(); await g.validate(seal()); const v = entry();
  const validation = await g.validate({ ...v, snapshot: { ...v.snapshot, sessionId: "other" } });
  assert.equal(validation.ok, false);
  if (!validation.ok) assert.ok(validation.issues.some(i => i.code === "wrong-session"));
});

test("a rejected malformed first input leaves the guard unbound (ISSUE-305)", async () => {
  const g = guard();
  const v = entry();
  const first = await g.validate({ ...v, snapshot: { ...v.snapshot, sessionId: "" } });
  assert.equal(first.ok, false, "the malformed first input is refused");
  // The real session must validate normally afterwards: the refused first
  // input never bound the instance to its empty session id.
  const second = await g.validate(seal());
  assert.equal(second.ok, true,
    `the real session validates after a rejected first input: ${JSON.stringify(second.ok ? second.breaker : second.issues)}`);
});

test("a ledger I/O throw during validation is ledger-io and never counts on the breaker (ISSUE-313)", async () => {
  // A seal whose episode member carries evidence provenance: checking it reads
  // the ledger. A transient storage fault there is not a plan defect — it must
  // be classified distinctly and leave the breaker streak untouched, so two
  // storage blips cannot quiet the judge as if two bad plans were submitted.
  const v = seal();
  const node = result({ evidence: { ...result().evidence, sourceRecallId: "recall-evidence" } });
  const value = { ...v, snapshot: { ...v.snapshot, nodes: [message(), node] } };
  const throwing = { ...ledger(),
    recall: async () => { throw new LedgerError("storage", "Injected transient storage fault"); } };
  const g = new Guard({ ledger: throwing, initialState: { consecutiveValidationFailures: 0, disabled: false } });
  const validation = await g.validate(value);
  assert.equal(validation.ok, false, "the validation is refused");
  if (!validation.ok) {
    assert.ok(validation.issues.some(i => i.code === "ledger-io"),
      `a distinct storage classification: ${JSON.stringify(validation.issues)}`);
    assert.ok(!validation.issues.some(i => i.code === "invalid-plan"),
      "a storage fault is not a plan defect");
  }
  assert.equal(g.state().consecutiveValidationFailures, 0,
    "a transient storage fault never counts on the breaker");
  assert.equal(g.state().disabled, false, "the breaker stays armed");
});

test("a cap plan is refused: the entry-time cap has no application path", async () => {
  // ADR-0014 (2026-10-23) scrapped the cap. The declaration-only operation is
  // still in the type vocabulary, so the guard must refuse it, never apply it.
  const validation = await guard().validate(entry());
  assert.equal(validation.ok, false);
  if (!validation.ok) assert.ok(validation.issues.some(issue => issue.code === "invalid-plan"));
});

test("one invalid plan rejects the whole batch", async () => {
  const v = entry(); const validation = await guard().validate({ ...v, plans: [...v.plans,
    { ruleId: "seal", baseRevision: "stale", removals: [], notes: [], operations: [] }] });
  assert.equal(validation.ok, false);
  assert.equal("application" in validation, false);
});

test("append seal has no removals, replacements or archives", async () => {
  const validation = await guard().validate(seal());
  if (!validation.ok) assert.fail(JSON.stringify(validation.issues));
  assert.equal(validation.application.replacements.length, 0);
  assert.equal(validation.application.archives.length, 0);
  assert.equal(validation.application.appendRecords.length, 1);
});

test("a forget request round-trips privateCopy as plain data", () => {
  // The forget arm (chunk C1) must survive the guard's plain-copy gate, or its
  // own event would be refused before `checkForget` could read it.
  const request: ForgetRequest = { source: "src/app.ts",
    ranges: [{ startLine: 10, endLineInclusive: 20 }], label: "parser" };
  const input = { kind: "forget" as const, eventId: "forget-1", request };
  assert.deepEqual(privateCopy(input), input);
  assert.notEqual(privateCopy(input).request.ranges, request.ranges);
});

test("the three new checks say nothing on a plan they do not own", () => {
  // V0 lands the seams silent (ISSUE-045 §4.1): the proof lane, the forget
  // request and write invalidation must not change any existing outcome. Each
  // check runs on a real context and leaves the issue list empty.
  const c = context(entry());
  checkProofs(c, c.value.plans);
  checkForget(c);
  checkInvalidation(c, c.value.plans);
  assert.deepEqual(c.issues, []);
});
