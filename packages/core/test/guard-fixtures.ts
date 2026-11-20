import { EpisodeTracker } from "../src/episodes/tracker.js";
import type { EngineInput } from "../src/engine/types.js";
import type { Ledger, LedgerEntry } from "../src/ledger/types.js";
import type { PruneL2Removal, PruneRemoval } from "../src/prune/pass-merge.js";
import type { RulePlan } from "../src/rules/types.js";
import type { MessageNode, SessionSnapshot, ToolResultNode, TranscriptNode } from "../src/types/transcript.js";
import { sha256Sync } from "../src/util/hash.js";
import type { Verdict } from "../src/verdicts/types.js";
import type { CheckContext } from "../src/guard/context.js";
import { computeFreshZone } from "../src/guard/fresh-zone.js";
import type { ValidationInput } from "../src/guard/types.js";

/**
 * A prune event over a plain verdict list: the test-side stand-in for
 * `applyPruneAnswers`, which is what the mount hands the engine. A `keepall`
 * answers a keep; every other action is a removal carrying its own judged
 * claim, so `pruneVerdicts` reads the same batch back.
 *
 * The bulk prune is the only per-unit answer seam left (ADR-0028): the judge
 * lane's own `kind: 'verdict'` event is gone, so every guard test that needs a
 * per-unit answer travels this lane.
 */
export function pruneEvent(
  verdicts: readonly Verdict[], round = 1, window = 200_000,
): Extract<EngineInput, { readonly kind: "prune" }> {
  const removals: PruneRemoval[] = [];
  const kept: string[] = [];
  for (const verdict of verdicts) {
    if (verdict.action === "keepall") { kept.push(verdict.unitId); continue; }
    removals.push(removalOf(verdict));
  }
  return { kind: "prune", eventId: "prune-event", round,
    verdicts: { removals, kept, refused: [], rejected: [] }, window };
}

/** One verdict as the document row that claims the same removal. */
function removalOf(verdict: Verdict): PruneL2Removal {
  if (verdict.action === "keeplines") {
    return { unitId: verdict.unitId, origin: "l2", action: "keeplines",
      ranges: verdict.ranges, answeredInRound: verdict.answeredInRound };
  }
  if (verdict.action === "forgetlines") {
    return { unitId: verdict.unitId, origin: "l2", action: "forgetlines",
      ranges: verdict.ranges, answeredInRound: verdict.answeredInRound };
  }
  if (verdict.action !== "forgetall") throw new Error("a keepall claims no removal");
  return { unitId: verdict.unitId, origin: "l2", action: "forgetall",
    summary: verdict.summary, answeredInRound: verdict.answeredInRound };
}

export const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
export const bytes = encode("head\r\nbody\nlast");
export const ref = { nodeId: "result", sha256: sha256Sync(bytes), byteLength: bytes.length };
export function result(overrides: Partial<ToolResultNode> = {}): ToolResultNode {
  return { ...ref, id: ref.nodeId, kind: "tool-result", bytes: bytes.slice(),
    turnOrdinal: 1, stepOrdinal: 1, callId: "call", embeddedRecords: [],
    evidence: { kind: "read", target: { key: "needle", label: "needle" }, source: { ...ref },
      sourceRecallId: null, paths: [{ pathKey: "file", displayPath: "file.ts", title: null,
        lineCount: 3, byteLength: bytes.length, outcome: "miss" }] }, ...overrides };
}
export function message(overrides: Partial<MessageNode> = {}): MessageNode {
  const content = encode("assistant bytes");
  return { id: "assistant", kind: "message", role: "assistant", bytes: content,
    sha256: sha256Sync(content), byteLength: content.length, turnOrdinal: 1, stepOrdinal: 0,
    toolCallIds: ["call"], ...overrides };
}
export function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { sessionId: "session", revision: "revision", currentTurnOrdinal: 1,
    completedThroughTurnOrdinal: 0, currentStepOrdinal: 1, nodes: [message()],
    cache: { kind: "warm", watermarkNodeIndex: 0 },
    retentionEvidence: [], ...overrides };
}
export function capPlan(overrides: Partial<RulePlan> = {}): RulePlan {
  return { ruleId: "cap", baseRevision: "revision", removals: [{ id: "body", title: "Body",
    sources: [{ source: { ...ref }, ranges: [{ startByte: 6, endByteExclusive: bytes.length }] }] }],
    notes: [{ id: "marker", kind: "cap-marker", removalId: "body" }],
    operations: [{ kind: "cap", removalId: "body", keepHeadEndByte: 6, noteId: "marker" }], ...overrides };
}
export function entry(overrides: Partial<ValidationInput> = {}): ValidationInput {
  return { input: { kind: "entry", eventId: "event", result: result() }, snapshot: snapshot(),
    capabilities: { mutateResult: true, rewriteHistory: true, atRest: true, liveTokens: false,
      log: true, appendRecords: true, rehydrateOnResume: false },
    config: { thresholds: { capBytes: 8, capHeadBytes: 6, episodeNoNewPathSteps: null,
      sealMaxLatencyTurns: 1 }, freshZone: { maxNodes: null, maxBytes: null },
      sealMode: "append", validationFailureLimit: 2,
      protocol: { barBytes: 2048, minCutFreedBytes: 4096 } },
    plans: [capPlan()], sealedEpisodeIds: [], nowMs: 10, ...overrides };
}
export function seal(): ValidationInput {
  const s = snapshot({ nodes: [message(), result()], completedThroughTurnOrdinal: 1,
    currentTurnOrdinal: 2 });
  const episode = new EpisodeTracker({ noNewPathSteps: null }).detect({ sessionId: s.sessionId,
    results: [result()], currentStepOrdinal: s.currentStepOrdinal, completedThroughTurnOrdinal: 1 })[0];
  if (episode === undefined) throw new Error("Fixture episode missing");
  return entry({ input: { kind: "at-rest", eventId: "seal-event", reason: "turn-end" }, snapshot: s,
    plans: [{ ruleId: "seal", baseRevision: s.revision, removals: [],
      notes: [{ id: "fact", kind: "negative-fact", episodeId: episode.id }],
      operations: [{ kind: "seal", mode: "append", removalId: null, episodeId: episode.id, noteId: "fact" }] }] });
}
export function context(value: ValidationInput): CheckContext {
  const nodes: TranscriptNode[] = [...value.snapshot.nodes];
  if (value.input.kind === "entry") nodes.push(value.input.result);
  return { value, nodes: new Map(nodes.map(n => [n.id, n])), issues: [],
    episodes: new EpisodeTracker({ noNewPathSteps: value.config.thresholds.episodeNoNewPathSteps }).detect({
      sessionId: value.snapshot.sessionId, results: value.snapshot.nodes.filter(n => n.kind === "tool-result"),
      currentStepOrdinal: value.snapshot.currentStepOrdinal,
      completedThroughTurnOrdinal: value.snapshot.completedThroughTurnOrdinal }),
    freshStart: computeFreshZone(value.snapshot, value.config).startNodeIndex };
}
export function ledger(): Ledger {
  return { prepare: async () => { throw new Error("Guard must not prepare applications"); },
    append: async () => { throw new Error("Guard must not append ledger events"); },
    events: async function* (): AsyncIterable<LedgerEntry> { throw new Error("Unexpected ledger event read"); },
    recall: async () => { throw new Error("No recalled fixture"); }, close: async () => undefined };
}
