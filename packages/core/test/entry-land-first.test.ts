import assert from "node:assert/strict";
import { test } from "node:test";
import type { RacoonsConfig } from "../src/config.js";
import { planEntryDecision } from "../src/engine/planning.js";
import { RacoonsEngine } from "../src/engine/engine.js";
import type { EngineInput } from "../src/engine/types.js";
import type { EntryAnswer } from "../src/verdicts/entry-wire.js";
import { checkTranscript } from "../src/guard/checks-sources.js";
import { context as fixtureContext } from "./guard-fixtures.js";
import type { ValidationInput } from "../src/guard/types.js";
import type { Rule, RuleContext } from "../src/rules/types.js";
import type { SessionSnapshot, ToolResultNode } from "../src/types/transcript.js";
import type { TelemetryEvent } from "../src/types/telemetry.js";
import { UnitTracker } from "../src/units/tracker.js";
import { sha256Sync } from "../src/util/hash.js";
import { fixture, protocolFixture, TestLedger, TestPort } from "./engine-fixtures.js";

/**
 * The land-first entry path (ISSUE-058 chunk P3a; ADR-0022 §2–§3, §11–§14).
 *
 * Two facts are pinned here, each through code that can fail by name:
 *
 * 1. An entry OBSERVATION plans nothing in place. The host already wrote the
 *    result, so the engine mints the unit from the snapshot's own bytes and
 *    leaves the transcript alone — no plan, no host write, no ask, no rule pass.
 * 2. A DECISION happens only when the mount hands in an answer over the LANDED
 *    unit, and both snapshot shapes (result already landed, result not yet
 *    landed) are legal: `checkTranscript` reads neither as a duplicate node.
 */

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

/** One above-bar landed result with a hit path, the shape the tracker mints from. */
function landedNode(): ToolResultNode {
  const body = encode("src/landed.ts result body\nline two\nline three\nline four\n");
  const hash = sha256Sync(body);
  return { kind: "tool-result", id: "result-landed", turnOrdinal: 1, stepOrdinal: 2,
    bytes: body, sha256: hash, byteLength: body.length, callId: "call-landed",
    embeddedRecords: [], evidence: {
      kind: "read", target: null,
      source: { nodeId: "result-landed", sha256: hash, byteLength: body.length },
      sourceRecallId: null,
      paths: [{ pathKey: "src/landed.ts", displayPath: "src/landed.ts", title: null,
        lineCount: 4, byteLength: body.length, outcome: "hit" }] } };
}

function messageNode(): SessionSnapshot["nodes"][number] {
  const body = encode("read landed.ts");
  return { kind: "message", id: "assistant-landed", role: "assistant",
    toolCallIds: ["call-landed"], turnOrdinal: 1, stepOrdinal: 1,
    bytes: body, sha256: sha256Sync(body), byteLength: body.length };
}

/** The snapshot a real land-first host presents: the result is ALREADY a node. */
function landedSnapshot(): SessionSnapshot {
  return { sessionId: "session-landed", revision: "revision-1", currentTurnOrdinal: 2,
    completedThroughTurnOrdinal: 1, currentStepOrdinal: 3,
    nodes: [messageNode(), landedNode()],
    cache: { kind: "unknown" }, retentionEvidence: [] };
}

function landedUnitId(): string {
  const unit = new UnitTracker({ sessionId: "session-landed", barBytes: 0 })
    .unitsFor(landedNode())[0];
  if (unit === undefined) throw new Error("the landed result must mint one unit");
  return unit.id;
}

function config(): RacoonsConfig {
  return {
    thresholds: { capBytes: 1024 * 1024, capHeadBytes: null, episodeNoNewPathSteps: null,
      sealMaxLatencyTurns: 1 },
    freshZone: { maxNodes: null, maxBytes: null }, sealMode: "append",
    validationFailureLimit: 2,
    protocol: { barBytes: 8, minCutFreedBytes: 4096 },
  };
}

/** The entry event an answered mount hands in: the landed result and its stamp. */
function answeredEvent(answer: EntryAnswer, eventId = "e-shape"): EngineInput {
  return { kind: "entry", eventId, result: landedNode(), answer,
    stamp: { unitId: landedUnitId(), answeredInRound: 0 } };
}

/**
 * One observation path per row: the protocol fixture the engine is usually
 * opened over, and a real engine pass over a snapshot that already holds the
 * landed node. Every row must leave the transcript byte-identical and silent.
 */
interface ObservationRow {
  readonly name: string;
  /** Builds the engine, the port it writes through, and the input it is handed. */
  readonly arrange: () => Promise<{
    readonly engine: RacoonsEngine;
    readonly port: TestPort;
    readonly input: EngineInput;
    readonly events: TelemetryEvent[];
    readonly seen: RuleContext[];
  }>;
}

const OBSERVATION_ROWS: readonly ObservationRow[] = [
  { name: "an entry observation on the protocol fixture plans nothing in place",
    arrange: async () => {
      const base = await protocolFixture();
      const events: TelemetryEvent[] = [];
      const engine = await RacoonsEngine.open({ ...base.options,
        onTelemetry: event => events.push(event) });
      return { engine, port: base.port, events, seen: [],
        input: { kind: "entry", eventId: "entry-observed", result: base.port.incoming } };
    } },
  { name: "a real engine pass over a land-first entry event writes nothing",
    arrange: async () => {
      const snapshot = landedSnapshot();
      const ledger = new TestLedger();
      const port = new TestPort(snapshot, landedNode());
      const seen: RuleContext[] = [];
      const rules: Rule[] = [{ id: "spy",
        plan: context => { seen.push(context); return null; } }];
      const base = await fixture();
      const engine = await RacoonsEngine.open({ ...base.options, ledger, port, rules,
        sessionId: snapshot.sessionId,
        config: { ...base.options.config,
          protocol: { ...base.options.config.protocol, barBytes: 8 } } });
      return { engine, port, events: [], seen,
        input: { kind: "entry", eventId: "entry-landed", result: landedNode() } };
    } },
];

test("an entry observation plans nothing in place: the unit is minted, not applied", async () => {
  for (const row of OBSERVATION_ROWS) {
    const { engine, port, input, events, seen } = await row.arrange();
    const before = await port.snapshot();
    const outcome = await engine.process(input);
    // Nothing was planned: no host application, no shape, no in-place rewrite.
    assert.equal(outcome.status, "unchanged", `row: ${row.name} — the pass status`);
    assert.equal(port.requests.length, 0,
      `row: ${row.name} — an observation never applies anything`);
    assert.deepEqual(await port.snapshot(), before,
      `row: ${row.name} — the transcript is byte-identical afterwards`);
    assert.equal(events.some(event => event.kind === "validation"), false,
      `row: ${row.name} — no guard call is made for an observation`);
    assert.deepEqual(seen, [], `row: ${row.name} — the entry observation never reaches the rules`);
    assert.deepEqual((await port.snapshot()).nodes.map(node => node.id),
      before.nodes.map(node => node.id),
      `row: ${row.name} — every node keeps its identity, the landed one included`);
  }
});

/**
 * One land-first shape per row, each naming the check it exercises: the plan a
 * settled answer yields over the landed unit, and the guard's reading of a
 * snapshot that has (or has not) landed the result.
 */
type LandFirstRow =
  | { readonly check: "plan"; readonly name: string; readonly input: EngineInput;
      readonly expect: "shape" | "keepall" | "null" }
  | { readonly check: "snapshot"; readonly name: string; readonly landed: boolean };

const LAND_FIRST_ROWS: readonly LandFirstRow[] = [
  { check: "plan", name: "a keepall is a decision with no operation",
    input: answeredEvent({ action: "keepall" }, "e-keepall"), expect: "keepall" },
  { check: "plan", name: "a keeplines answer plans over the LANDED unit",
    input: answeredEvent({ action: "keeplines", ranges: [{ from: 1, to: 2 }],
      summary: "stale tail" }, "e-keeplines"), expect: "shape" },
  { check: "plan", name: "no answered entry, no decision",
    input: { kind: "entry", eventId: "e-unanswered", result: landedNode() }, expect: "null" },
  { check: "plan", name: "an answered entry with no stamp addresses no landed unit",
    input: { kind: "entry", eventId: "e-unstamped", result: landedNode(),
      answer: { action: "forgetall", summary: "stale" } }, expect: "null" },
  { check: "snapshot", name: "a snapshot carrying the landed result checks clean",
    landed: true },
  { check: "snapshot", name: "an unlanded result is added once, never twice",
    landed: false },
];

test("an answer plans over the landed unit, and either landed snapshot checks clean", () => {
  const snapshot = landedSnapshot();
  for (const row of LAND_FIRST_ROWS) {
    if (row.check === "snapshot") {
      const value: ValidationInput = { input: { kind: "entry", eventId: "entry-1",
        result: landedNode() },
        snapshot: row.landed ? snapshot : { ...snapshot, nodes: [messageNode()] },
        capabilities: { mutateResult: true, rewriteHistory: false, atRest: true,
          liveTokens: false, log: true, appendRecords: true, rehydrateOnResume: false },
        config: config(), plans: [], sealedEpisodeIds: [], nowMs: 10 };
      const c = fixtureContext(value);
      checkTranscript(c);
      assert.deepEqual(c.issues.map(issue => issue.code), [],
        `row: ${row.name} — a land-first result is never a duplicate node`);
      continue;
    }
    const decision = planEntryDecision(row.input, snapshot);
    if (row.expect === "null") {
      assert.equal(decision, null, `row: ${row.name} — the planner decides nothing`);
      continue;
    }
    assert.notEqual(decision, null, `row: ${row.name} — the planner decided something`);
    assert.equal(decision?.action, row.expect, `row: ${row.name} — the decision's action`);
    if (row.expect === "keepall") {
      assert.deepEqual(decision, { action: "keepall" },
        `row: ${row.name} — a keepall plans no operation: the mount rewinds the ask away`);
      continue;
    }
    if (decision?.action !== "shape") continue;
    assert.equal(decision.unitId, landedUnitId(),
      `row: ${row.name} — the plan names the landed unit, never a re-derived one`);
    assert.deepEqual(decision.keptLineRanges, [{ startLine: 1, endLineInclusive: 2 }],
      `row: ${row.name} — the kept lines are the answer's own span`);
    assert.deepEqual(decision.bankOver, landedNode().bytes,
      `row: ${row.name} — the bank covers the ORIGINAL landed body`);
    assert.notDeepEqual(decision.replacementBytes, landedNode().bytes,
      `row: ${row.name} — the new turn is shaped bytes, never the landed body`);
    assert.equal(new TextDecoder().decode(decision.replacementBytes)
      .includes("kept lines 1–2 of 4"), true,
    `row: ${row.name} — the shaped bytes name the kept span`);
  }
});

/**
 * The engine-level entry decision rows (ISSUE-268). Each row is one answer the
 * engine hands to `planEntryDecision` itself; the pass must journal that
 * decision's own code, apply nothing, and leave the next pass runnable.
 */
const ENTRY_DECISION_ROWS: readonly {
  readonly name: string;
  readonly answer: EntryAnswer;
  readonly code: string;
  readonly status: "rejected" | "unchanged";
}[] = [
  { name: "a span past the landed body", code: "spans-outside-result", status: "rejected",
    answer: { action: "keeplines", ranges: [{ from: 1, to: 9 }], summary: "past the end" } },
  { name: "a shape that keeps every line", code: "keeps-every-line", status: "rejected",
    answer: { action: "forgetlines", ranges: [], summary: "nothing leaves" } },
  { name: "an action outside the grammar", code: "unknown-answer", status: "rejected",
    answer: { action: "keephead", ranges: [], summary: "first lines" } as unknown as EntryAnswer },
  { name: "a keep-all decision", code: "keepall", status: "unchanged",
    answer: { action: "keepall" } },
];

test("an answered entry journals its decision code and the next pass still runs", async () => {
  for (const row of ENTRY_DECISION_ROWS) {
    const events: TelemetryEvent[] = [];
    const snapshot = landedSnapshot();
    const ledger = new TestLedger();
    const port = new TestPort(snapshot, landedNode());
    const base = await fixture();
    const engine = await RacoonsEngine.open({ ...base.options, ledger, port,
      sessionId: snapshot.sessionId, onTelemetry: event => events.push(event) });
    const eventId = `e-${row.code}`;
    const outcome = await engine.process(answeredEvent(row.answer, eventId));
    assert.equal(outcome.status, row.status, `row: ${row.name} — the pass status`);
    const validation = ledger.entries.find(({ event }) => event.kind === "validation"
      && event.eventId === eventId)?.event;
    assert.ok(validation?.kind === "validation",
      `row: ${row.name} — the refusal is a validation row, not skip/no-plan`);
    assert.equal(validation.issues[0]?.code, row.code,
      `row: ${row.name} — the row carries the entry planner's own code`);
    assert.equal(events.filter(event => event.kind === "validation"
      && event.eventId === eventId).length, 1,
    `row: ${row.name} — exactly one validation telemetry event names the decision`);
    assert.equal(port.requests.length, 0,
      `row: ${row.name} — a decision that is not a shape applies nothing`);
    const next = await engine.process({ kind: "at-rest", eventId: `after-${row.code}`,
      reason: "step" });
    assert.notEqual(next.status, "recovery-pending",
      `row: ${row.name} — one refused answer does not fault the engine`);
  }
});

/**
 * A malformed entry must be coded on its FIRST pass (ISSUE-268). The old path
 * hashed `input.result.bytes` before the entry decision, so a missing or
 * non-byte result threw into `recovery-pending`, recorded the id as refetched,
 * and only the retry reached `unknown-answer`. Each row asserts the first pass
 * journals the code, the same id retried reads that same row, and the engine
 * still runs afterwards.
 */
const MALFORMED_ENTRY_ROWS: readonly {
  readonly name: string;
  readonly code: string;
  readonly event: object;
}[] = [
  { name: "an answered entry with no landed result", code: "unknown-answer",
    event: { kind: "entry", eventId: "malformed-entry-no-result",
      answer: { action: "keepall" },
      stamp: { unitId: landedUnitId(), answeredInRound: 0 } } },
  { name: "an answered entry whose result bytes are not bytes", code: "unknown-answer",
    event: { kind: "entry", eventId: "malformed-entry-bad-bytes",
      result: { ...landedNode(), bytes: "not a Uint8Array" },
      answer: { action: "keepall" },
      stamp: { unitId: landedUnitId(), answeredInRound: 0 } } },
  { name: "an entry observation with no landed result", code: "invalid-plan",
    event: { kind: "entry", eventId: "malformed-entry-observation" } },
];

test("a malformed entry is refused by code on the first pass and stays stable", async () => {
  for (const row of MALFORMED_ENTRY_ROWS) {
    const snapshot = landedSnapshot();
    const ledger = new TestLedger();
    const port = new TestPort(snapshot, landedNode());
    const base = await fixture();
    const engine = await RacoonsEngine.open({ ...base.options, ledger, port,
      sessionId: snapshot.sessionId });
    const input = row.event as unknown as EngineInput;
    const eventId = (row.event as { readonly eventId: string }).eventId;
    const rows = (): number => ledger.entries.filter(({ event }) =>
      event.kind === "validation" && event.eventId === eventId).length;
    const first = await engine.process(input);
    assert.equal(first.status, "rejected",
      `row: ${row.name} — the first pass is refused, not recovery-pending`);
    assert.equal(first.validation?.ok, false, `row: ${row.name} — the refusal is coded`);
    assert.equal(first.validation?.issues[0]?.code, row.code,
      `row: ${row.name} — the first pass names the code`);
    assert.equal(rows(), 1, `row: ${row.name} — one validation row is journaled`);
    assert.equal(port.requests.length, 0, `row: ${row.name} — nothing applies`);
    const retried = await engine.process(input);
    assert.equal(retried.status, "rejected", `row: ${row.name} — the retry is stable`);
    assert.equal(retried.validation?.ok, false, `row: ${row.name} — the retry is coded`);
    assert.equal(retried.validation?.issues[0]?.code, row.code,
      `row: ${row.name} — the retry reports the same code`);
    assert.equal(rows(), 1, `row: ${row.name} — the retry appends no second row`);
    const next = await engine.process({ kind: "at-rest",
      eventId: `after-${eventId}`, reason: "step" });
    assert.notEqual(next.status, "recovery-pending",
      `row: ${row.name} — the next pass still runs`);
  }
});
