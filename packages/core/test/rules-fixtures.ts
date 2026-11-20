import { DEFAULT_CONFIG } from "../src/config.js";
import type { RacoonsConfig, Thresholds } from "../src/config.js";
import type { Episode } from "../src/episodes/types.js";
import type { RuleContext } from "../src/rules/types.js";
import type {
  MessageNode,
  PathEvidence,
  SessionSnapshot,
  ToolResultNode,
} from "../src/types/transcript.js";
import { sha256 } from "../src/util/hash.js";

export function ruleConfig(
  thresholds: Partial<Thresholds> = {},
  options: Partial<Omit<RacoonsConfig, "thresholds">> = {},
): RacoonsConfig {
  return {
    ...DEFAULT_CONFIG,
    ...options,
    thresholds: {
      ...DEFAULT_CONFIG.thresholds,
      capBytes: 8,
      capHeadBytes: 4,
      ...thresholds,
    },
  };
}

export function pathEvidence(overrides: Partial<PathEvidence> = {}): PathEvidence {
  return {
    pathKey: "src/example.ts",
    displayPath: "src/example.ts",
    title: null,
    lineCount: null,
    byteLength: null,
    outcome: "miss",
    ...overrides,
  };
}

export async function toolResult(
  text: string,
  overrides: Partial<ToolResultNode> = {},
): Promise<ToolResultNode> {
  const bytes = new TextEncoder().encode(text);
  const hash = await sha256(bytes);
  const id = overrides.id ?? "result-1";
  return {
    id,
    kind: "tool-result",
    turnOrdinal: 2,
    stepOrdinal: 3,
    bytes,
    sha256: hash,
    byteLength: bytes.byteLength,
    callId: `call:${id}`,
    evidence: {
      kind: "read",
      target: { key: "missing-symbol", label: "missingSymbol" },
      paths: [pathEvidence()],
      source: { nodeId: id, sha256: hash, byteLength: bytes.byteLength },
      sourceRecallId: null,
    },
    embeddedRecords: [],
    ...overrides,
  };
}

export function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: "episode-1",
    target: { key: "missing-symbol", label: "missingSymbol" },
    status: "closed",
    openedAtStep: 1,
    lastNewPathStep: 3,
    memberNodeIds: ["result-1"],
    hitNodeIds: [],
    missNodeIds: ["result-1"],
    unknownNodeIds: [],
    paths: [pathEvidence()],
    closedAtStep: 3,
    closedAtTurn: 2,
    closeReason: "turn-end",
    ...overrides,
  };
}

interface ContextFixture extends Partial<Omit<RuleContext, "snapshot">> {
  readonly snapshot?: Partial<SessionSnapshot>;
}

export function ruleContext(fixture: ContextFixture = {}): RuleContext {
  const { snapshot, ...overrides } = fixture;
  const context: RuleContext = {
    input: { kind: "at-rest", eventId: "event-1", reason: "turn-end" },
    snapshot: {
      sessionId: "session-1",
      revision: "revision-1",
      currentTurnOrdinal: 3,
      completedThroughTurnOrdinal: 2,
      currentStepOrdinal: 4,
      nodes: [],
      cache: { kind: "warm", watermarkNodeIndex: 0 },
      retentionEvidence: [],
      ...snapshot,
    },
    capabilities: {
      mutateResult: true,
      rewriteHistory: false,
      atRest: true,
      liveTokens: false,
      log: true,
      appendRecords: true,
      rehydrateOnResume: false,
    },
    config: ruleConfig(),
    freshZone: { startNodeIndex: 0, endNodeIndexExclusive: 0 },
    episodes: [],
    sealedEpisodeIds: [],
    reservedNodeIds: [],
    estimatedContentTokens: 0,
    latestUsage: null,
    nowMs: 1234,
    ...overrides,
  };
  return context;
}

// Message nodes are invalid EngineInput results; this fixture tests runtime refusal.
export function entryWithMessage(
  result: ToolResultNode,
  role: MessageNode["role"],
): RuleContext {
  const message: MessageNode = {
    id: result.id,
    kind: "message",
    role,
    turnOrdinal: result.turnOrdinal,
    stepOrdinal: result.stepOrdinal,
    bytes: result.bytes,
    sha256: result.sha256,
    byteLength: result.byteLength,
    toolCallIds: [],
  };
  const input = {
    kind: "entry",
    eventId: "event-1",
    result: message,
  } as unknown as RuleContext["input"];
  return ruleContext({ input });
}
