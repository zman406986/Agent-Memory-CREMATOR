import assert from "node:assert/strict";
import { test } from "node:test";
import { Guard } from "../src/guard/guard.js";
import { computeFreshZone } from "../src/guard/fresh-zone.js";
import { bytes, entry, ledger, message, result, seal, snapshot } from "./guard-fixtures.js";
import type { RulePlan } from "../src/rules/types.js";
import { UnitTracker } from "../src/units/tracker.js";

function guard(): Guard {
  return new Guard({ ledger: ledger(), initialState: { consecutiveValidationFailures: 0, disabled: false } });
}

test("M1 rejects a replace seal even at a cold boundary", async () => {
  const v = seal(), original = v.plans[0]?.operations[0];
  if (original?.kind !== "seal") throw new Error("Missing seal");
  const node = result(), removal = { id: "body", title: "Body", sources: [{ source: {
    nodeId: node.id, sha256: node.sha256, byteLength: node.byteLength,
  }, ranges: [{ startByte: 0, endByteExclusive: node.byteLength }] }] };
  const plan: RulePlan =
    { ruleId: "seal", baseRevision: "revision", removals: [removal], notes: [{ kind: "negative-fact",
      id: "marker", episodeId: original.episodeId }], operations: [{ ...original, mode: "replace", removalId: "body", noteId: "marker" }] };
  const validation = await guard().validate({ ...v, plans: [plan], sealedEpisodeIds: [],
    snapshot: { ...v.snapshot, cache: { kind: "cold", boundary: { kind: "resume", observedAtMs: 1 } } } });
  assert.equal(validation.ok, false,
    "row: replace seal at a cold boundary — a replace seal is refused even where a boundary would license it");
  if (!validation.ok) assert.ok(validation.issues.some(i => i.code === "unsupported-capability"),
    "row: replace seal at a cold boundary — the refusal names the unsupported capability");
  assert.equal("application" in validation, false,
    "row: replace seal at a cold boundary — a refused plan ships no application");
});

/** A warm snapshot with three nodes: the watermark is the only eligibility lever. */
function warm(): { readonly snapshot: ReturnType<typeof snapshot>;
  readonly config: ReturnType<typeof entry>["config"] } {
  const s = snapshot({ nodes: [message(), result(), result({ id: "other" })],
    cache: { kind: "warm", watermarkNodeIndex: 2 } });
  return { snapshot: s, config: entry().config };
}

/**
 * One row per boundary rule. Both rows read the same warm snapshot so the only
 * variable is the knob under test: a row that passed with the other knob's value
 * would not be measuring its own rule.
 */
const CASES: readonly (readonly [string, () => void])[] = [
  ["warm byte limits never expand eligibility below the watermark", () => {
    const { snapshot: s, config } = warm();
    assert.equal(computeFreshZone(s, { ...config, freshZone: { maxNodes: 100, maxBytes: 100000 } }).startNodeIndex, 2,
      "row: warm byte limits never expand eligibility below the watermark — a generous byte limit cannot walk the zone past the watermark");
    assert.equal(computeFreshZone(s, { ...config, freshZone: { maxNodes: null, maxBytes: bytes.length - 1 } }).startNodeIndex, 3,
      "row: warm byte limits never expand eligibility below the watermark — a byte limit too small for the watermark node does advance the start");
  }],
  ["standalone RACOONS records survive by scope: no unit names their bytes", () => {
    // ADR-0020/ADR-0023: a record is not protected, it is never a candidate. The
    // tracker mints units from tool-result nodes only, so nothing can name it.
    const node = result();
    const s = snapshot({ nodes: [{ id: "record", kind: "racoons-record", recordId: "record-id",
      turnOrdinal: 0, stepOrdinal: 0, bytes: node.bytes, sha256: node.sha256, byteLength: node.byteLength }] });
    assert.deepEqual(new UnitTracker({ sessionId: s.sessionId, barBytes: 0 }).units(s), [],
      "row: standalone RACOONS records survive by scope — a record node yields no unit, so no rule can name it");
  }],
];

test("guard boundaries — one row per boundary rule", () => {
  for (const [name, run] of CASES) {
    try { run(); } catch (error) {
      if (error instanceof Error && error.message.startsWith(`row: ${name}`)) throw error;
      throw new Error(`row: ${name} — ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
});
