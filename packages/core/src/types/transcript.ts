import type {
  ByteRange,
  Bytes,
  LineRange,
  NodeId,
  RecallId,
  Revision,
  SearchTarget,
  SessionId,
  Sha256,
  SourceRef,
  ToolCallId,
} from "./identity.js";

export interface ToolEvidence {
  /**
   * What the call did. `write` proves a path changed — never that a search
   * space was empty (PRD §6.6, §6.7; ISSUE-045 chunk E0 derives it, C6 uses it).
   */
  readonly kind: "read" | "search" | "glob" | "write" | "other";
  readonly target: SearchTarget | null;
  readonly paths: readonly PathEvidence[];
  readonly source: SourceRef;
  readonly sourceRecallId: RecallId | null;
  /**
   * The host's own report that the call failed (ISSUE-328). `true` means the
   * call changed nothing and returned nothing: a failed write is never proof a
   * path changed, and a failed read never holds the file's bytes. Absent means
   * the host declared no failure — never a guess from the result's wording.
   */
  readonly failed?: boolean;
}

export interface PathEvidence {
  readonly pathKey: string;
  readonly displayPath: string;
  readonly title: string | null;
  readonly lineCount: number | null;
  readonly byteLength: number | null;
  readonly outcome: "hit" | "miss" | "unknown";
  /**
   * How much of the file this observation covers, when the host declared it
   * (ADR-0037 decision 2, class 2). `"full"` means the call named no
   * `offset`/`limit` and the result reported no truncation; `"partial"` means
   * the call asked for a slice. Absent means the host declared nothing, and an
   * unannotated observation is never a witness: the superseded-read dedupe pass
   * reads this field and only this field for coverage, and a host-truncated read
   * is never `"full"`.
   */
  readonly coverage?: "full" | "partial";
}

export interface TranscriptNodeBase {
  readonly id: NodeId;
  readonly turnOrdinal: number;
  readonly stepOrdinal: number;
  readonly bytes: Bytes;
  readonly sha256: Sha256;
  readonly byteLength: number;
}

/**
 * What the host declared about a message's origin (ADR-0037 decision 5;
 * ISSUE-149). `sourceKind` is the host's own label, carried verbatim: core never
 * maps it to a role, never matches it against a list, and never infers it from
 * wording. `familyId` is the host's grouping id when it declares one.
 */
export interface MessageProvenance {
  readonly sourceKind: string;
  readonly familyId?: string;
}

export interface MessageNode extends TranscriptNodeBase {
  readonly kind: "message";
  readonly role: "system" | "developer" | "user" | "assistant";
  readonly toolCallIds: readonly ToolCallId[];
  /**
   * The host's declared provenance, or the property absent. Absence is
   * meaningful: it says the host declared nothing, and it is never guessed from
   * the role or the bytes. An undeclared message is never a dedupe candidate
   * and never a witness (ISSUE-149).
   */
  readonly provenance?: MessageProvenance;
}

export interface ToolResultNode extends TranscriptNodeBase {
  readonly kind: "tool-result";
  readonly callId: ToolCallId;
  /**
   * The request's own argument payload, declared by the host verbatim (the
   * call-echo dedupe's declared payload; ADR-0037 decision 2, class 1;
   * ISSUE-151). Absent means the host declared nothing, and an undeclared
   * argument payload is never guessed from the result's bytes: the class
   * refuses instead. It is never a removal subject — the arguments stay
   * untouched — only the copy an exact echo is proved against.
   */
  readonly callArguments?: Bytes;
  readonly evidence: ToolEvidence;
  readonly embeddedRecords: readonly ByteRange[];
}

export interface RacoonsRecordNode extends TranscriptNodeBase {
  readonly kind: "racoons-record";
  readonly recordId: string;
}

export type TranscriptNode =
  | MessageNode
  | ToolResultNode
  | RacoonsRecordNode;

export interface ColdBoundary {
  readonly kind: "resume" | "idle-past-ttl" | "model-switch";
  readonly observedAtMs: number;
}

export type CacheState =
  | {
      readonly kind: "warm";
      readonly watermarkNodeIndex: number;
    }
  | {
      readonly kind: "cold";
      readonly boundary: ColdBoundary;
    }
  | {
      readonly kind: "unknown";
    };

export interface FreshZone {
  readonly startNodeIndex: number;
  readonly endNodeIndexExclusive: number;
}

/**
 * Per-path byte coverage across every result-producing call, tool-name
 * agnostic (PRD §6.6; ISSUE-045 chunk C5 measures it). The shape is the meter's
 * `PathCoverage` row, so a meter's `bytesByPath()` is assignable here without
 * either side importing the other. Bytes are facts: no threshold, bar or score
 * rides on them (ADR-0006).
 */
export interface PathCoverageFact {
  readonly pathKey: string;
  /** Every byte recorded for this path: hit + miss + unknown. */
  readonly bytes: number;
  readonly hitBytes: number;
  readonly missBytes: number;
  /** Bytes whose outcome is unknown: counted, but proof of nothing. */
  readonly unknownBytes: number;
  readonly observations: number;
}

export interface RetentionEvidence {
  readonly kind: "cross-reference" | "access";
  readonly source: SourceRef;
  readonly keepLines: readonly LineRange[];
  readonly witnessNodeIds: readonly NodeId[];
}

export interface SessionSnapshot {
  readonly sessionId: SessionId;
  readonly revision: Revision;
  readonly currentTurnOrdinal: number;
  readonly completedThroughTurnOrdinal: number;
  readonly currentStepOrdinal: number;
  readonly nodes: readonly TranscriptNode[];
  readonly cache: CacheState;
  readonly retentionEvidence: readonly RetentionEvidence[];
  /**
   * Per-path byte coverage the harness (or the meter) already observed, one row
   * per path, in the meter's order (PRD §6.6; ISSUE-045 chunk C5). Absent means
   * "not measured here"; nothing sums this field, and no rule reads it.
   */
  readonly pathCoverage?: readonly PathCoverageFact[];
}

export interface CapabilityFlags {
  readonly mutateResult: boolean;
  readonly rewriteHistory: boolean;
  /**
   * The programmatic revert seam (ADR-0007): the host can restore a cached
   * prefix and append replacements. Optional because a host that has not
   * declared it cannot apply a verdict removal; absence is refused, never
   * assumed. Slice 4's dsh factory supplies it.
   */
  readonly revertHistory?: boolean;
  readonly atRest: boolean;
  readonly liveTokens: boolean;
  readonly log: boolean;
  readonly appendRecords: boolean;
  readonly rehydrateOnResume: boolean;
}

export interface Clock {
  nowMs(): number;
}
