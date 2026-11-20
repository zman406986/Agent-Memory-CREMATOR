import assert from "node:assert/strict";
import { test } from "node:test";
import type { RacoonsConfig } from "../src/config.js";
import { Guard } from "../src/guard/guard.js";
import type { ValidationCode, ValidationInput } from "../src/guard/types.js";
import type { ProofKind, RulePlan } from "../src/rules/types.js";
import type { CapabilityFlags, MessageNode, TranscriptNode, ToolResultNode } from "../src/types/transcript.js";
import { UnitTracker } from "../src/units/tracker.js";
import type { ProcessingUnit } from "../src/units/types.js";
import { sha256Sync } from "../src/util/hash.js";
import { ledger, context } from './guard-fixtures.js';
import { buildCandidate } from "../src/guard/candidate.js";
import type { Candidate } from "../src/guard/candidate.js";
import { finalizeCandidate } from "../src/guard/finalize.js";

/**
 * What a proof burn leaves in the transcript (ADR-0018 §2; PRD §6.6).
 *
 * A `proof` op materializes on the same branch as a verdict: the unit's bytes
 * leave, one receipt line takes their place, and the archive answers a recall id.
 * What a proof receipt must *not* carry is as load-bearing as what it must:
 * there is no descriptor slot, so the line names path, burned ranges and recall
 * id and nothing else. The applicant is told what was not retained, never why.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sessionId = "session";
const barBytes = 8;
const path = "src/app.ts";

const config: RacoonsConfig = {
  thresholds: {
    capBytes: 8, capHeadBytes: null, episodeNoNewPathSteps: null,
    sealMaxLatencyTurns: 1,
  },
  freshZone: { maxNodes: null, maxBytes: null },
  sealMode: "append",
  validationFailureLimit: 2,
  protocol: {
    barBytes, minCutFreedBytes: 4096,
  },
};

function toolResult(options: {
  readonly id: string;
  readonly step: number;
  readonly kind: ToolResultNode["evidence"]["kind"];
}): ToolResultNode {
  const bytes = encoder.encode("alpha line\nbeta line\n");
  const sha256 = sha256Sync(bytes);
  return {
    id: options.id, kind: "tool-result", turnOrdinal: 1, stepOrdinal: options.step,
    bytes, sha256, byteLength: bytes.length, callId: `call-${options.id}`,
    evidence: {
      kind: options.kind, target: { key: path, label: path },
      source: { nodeId: options.id, sha256, byteLength: bytes.length },
      sourceRecallId: null,
      paths: [{ pathKey: path, displayPath: path, title: null, lineCount: 2,
        byteLength: bytes.length, outcome: options.kind === "write" ? "unknown" : "hit" }],
    },
    embeddedRecords: [],
  };
}

function assistant(): MessageNode {
  const bytes = encoder.encode("assistant bytes");
  return {
    id: "assistant", kind: "message", role: "assistant", bytes,
    sha256: sha256Sync(bytes), byteLength: bytes.length, turnOrdinal: 1, stepOrdinal: 0,
    toolCallIds: ["call-result-0", "call-result-1"],
  };
}

function capabilities(): CapabilityFlags {
  return {
    mutateResult: true, rewriteHistory: false, atRest: true, liveTokens: false,
    log: true, appendRecords: true, rehydrateOnResume: false, revertHistory: true,
  };
}

function known<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Missing ${what}`);
  return value;
}

interface Settled {
  readonly input: ValidationInput;
  readonly unit: ProcessingUnit;
  readonly text: string;
}

/**
 * A read of `path` and a write to it afterwards, so the read's bytes are proven
 * stale. The removed node's body is the read's whole text, so its receipt names
 * no range and the line shape is the floor form.
 */
function settled(): Settled {
  const text = "alpha line\nbeta line\n";
  const nodes: TranscriptNode[] = [assistant(),
    toolResult({ id: "result-0", step: 1, kind: "read" }),
    toolResult({ id: "result-1", step: 2, kind: "write" })];
  const snapshot = {
    sessionId, revision: "revision-1", currentTurnOrdinal: 2, completedThroughTurnOrdinal: 1,
    currentStepOrdinal: 2, nodes,
    cache: { kind: "warm" as const, watermarkNodeIndex: 0 }, retentionEvidence: [],
  };
  const unit = known(new UnitTracker({ sessionId, barBytes }).units(snapshot)[0], "unit");
  return {
    unit, text,
    input: {
      input: { kind: "at-rest", eventId: "at-rest-event", reason: "step" },
      snapshot, capabilities: capabilities(), config,
      plans: [proofPlan(unit, "stale-read")], sealedEpisodeIds: [], nowMs: 10,
    },
  };
}

function proofPlan(unit: ProcessingUnit, proofKind: ProofKind): RulePlan {
  return {
    ruleId: proofKind,
    baseRevision: "revision-1",
    removals: [{ id: unit.id, title: `stale ${path}`, sources: [{
      source: { ...unit.source }, ranges: [{ ...unit.span.byteRange }],
    }] }],
    notes: [{ id: `receipt:${unit.id}`, kind: "proof-receipt", proofKind,
      removalId: unit.id, unitId: unit.id, path: path, ranges: [] }],
    operations: [{ kind: "proof", proofKind, removalId: unit.id, unitId: unit.id,
      noteId: `receipt:${unit.id}` }],
  };
}

function codes(issues: readonly { readonly code: ValidationCode }[]): ValidationCode[] {
  return [...new Set(issues.map(issue => issue.code))];
}

const guardOf = (): Guard => new Guard({ ledger: ledger(),
  initialState: { consecutiveValidationFailures: 0, disabled: false } });

/**
 * One row per rule a proof burn must satisfy. Every row starts from the same
 * `settled()` scene and one row breaks one thing, so a row's failure names the
 * rule it broke rather than the fixture. The three families are the burn's own
 * output, a forged plan the guard must refuse before rendering, and a host that
 * swaps the bytes after the guard approved them — the same "what ships is what
 * was vetted" rule seen from three sides.
 */
const CASES: readonly {
  readonly name: string;
  readonly run: () => Promise<void>;
}[] = [
  {
    name: "one receipt names its path and recall id, with no descriptor",
    run: async () => {
      const name = "one receipt names its path and recall id, with no descriptor";
      const scene = settled();
      const validation = await guardOf().validate(scene.input);
      if (!validation.ok) assert.fail(JSON.stringify(validation.issues));
      assert.equal(validation.application.mode, "revert",
        `row: ${name} — a proof burn is a checkpoint-revert`);
      assert.equal(validation.application.appendRecords.length, 1,
        `row: ${name} — one receipt per proof op`);
      const record = known(validation.application.appendRecords[0], "receipt record");
      const archive = known(validation.application.archives[0], "archive");
      const text = decoder.decode(record.bytes);
      assert.equal(text, `[not retained] ${path} · necromancy ${archive.recall.id}`,
        `row: ${name} — the floor line: path, recall id, nothing else`);
      assert.ok(text.includes(archive.recall.id),
        `row: ${name} — the receipt names its own archive`);
      // No descriptor is not a missing label: there is no slot to fill, so no
      // "about:" segment can appear however the plan is shaped.
      assert.equal(text.includes("— about:"), false,
        `row: ${name} — a proof receipt has no descriptor slot`);
      assert.equal(validation.application.replacements.length, 0,
        `row: ${name} — a proof burn is never an in-place rewrite`);
    },
  },
  {
    name: "the proof receipt is the only generated record and the archive is not a verdict's",
    run: async () => {
      const name = "the proof receipt is the only generated record and the archive is not a verdict's";
      const scene = settled();
      const validation = await guardOf().validate(scene.input);
      if (!validation.ok) assert.fail(JSON.stringify(validation.issues));
      const application = validation.application;
      assert.equal(application.appendRecords.length, 1,
        `row: ${name} — the receipt is the application's only generated record`);
      assert.equal(application.archives.length, 1,
        `row: ${name} — the burn archives exactly the unit it removed`);
      assert.equal(application.archives[0]?.operationKind, "proof",
        `row: ${name} — the archive is a proof archive, not a verdict's`);
      assert.equal(application.sealedEpisodeIds.length, 0,
        `row: ${name} — a proof burn seals no episode`);
      // The rendered bytes are what the candidate declared, so a host that ships
      // them ships a vetted line (checks-output audits every record).
      const candidate = await buildCandidate(context(scene.input));
      assert.deepEqual(candidate.appendRecords, application.appendRecords,
        `row: ${name} — the candidate's records are the guard's own bytes, not a second rendering`);
    },
  },
  {
    name: "a forged proof receipt path is invalid-note before anything renders",
    run: async () => {
      const name = "a forged proof receipt path is invalid-note before anything renders";
      const scene = settled();
      const plan = known(scene.input.plans[0], "plan");
      const forged: RulePlan = { ...plan, notes: plan.notes.map(note => note.kind === "proof-receipt"
        ? { ...note, path: "src/other.ts" } : note) };
      const validation = await guardOf().validate({ ...scene.input, plans: [forged] });
      assert.equal(validation.ok, false, `row: ${name} — the forged note refuses the plan`);
      if (validation.ok) return;
      assert.deepEqual(codes(validation.issues), ["invalid-note"],
        `row: ${name} — the only code is the note's, so the refusal names the forged field`);
    },
  },
  {
    name: "the final record audit refuses a proof receipt whose bytes were swapped",
    run: async () => {
      const name = "the final record audit refuses a proof receipt whose bytes were swapped";
      const scene = settled();
      const candidate = await buildCandidate(context(scene.input));
      const clean = finalizeCandidate(context(scene.input), candidate);
      assert.equal(clean.ok, true, `row: ${name} — the unmutated candidate must pass first`);
      const mutated: Candidate = { ...candidate, appendRecords: candidate.appendRecords.map(record => {
        const bytes = record.bytes.slice();
        bytes[0] = (bytes[0] ?? 0) ^ 1;
        return { ...record, bytes };
      }) };
      const result = finalizeCandidate(context(scene.input), mutated);
      assert.equal(result.ok, false, `row: ${name} — a byte swap after the guard is refused`);
      if (result.ok) return;
      assert.ok(codes(result.issues).includes("invalid-generated-record"),
        `row: ${name} — the refusal names the generated record, got ${JSON.stringify(result.issues)}`);
    },
  },
];

test("proof burn materialization — one row per rule", async () => {
  for (const row of CASES) await row.run();
});
