import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import type { FixtureData } from './format.js';
import type { SessionSnapshot, SourceRef, TranscriptNode } from './types.js';
import { validateFixture } from './validate.js';

function snapshot(data: FixtureData): SessionSnapshot {
  const nodes: TranscriptNode[] = data.nodes.map((node) => {
    const bytes = new TextEncoder().encode(node.content.utf8.repeat(node.content.repeat ?? 1));
    const base = {
      id: node.id,
      turnOrdinal: node.turnOrdinal,
      stepOrdinal: node.stepOrdinal,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
    };
    if (node.kind === 'message') {
      return { ...base, kind: node.kind, role: node.role, toolCallIds: node.toolCallIds };
    }
    for (const range of node.embeddedRecords) {
      assert(range.endByteExclusive <= base.byteLength, `${node.id}: embedded record exceeds byte length`);
    }
    const source: SourceRef = { nodeId: base.id, sha256: base.sha256, byteLength: base.byteLength };
    return {
      ...base,
      kind: node.kind,
      callId: node.callId,
      evidence: { ...node.evidence, source },
      embeddedRecords: node.embeddedRecords,
    };
  });
  return {
    sessionId: data.sessionId,
    revision: data.revision,
    currentTurnOrdinal: data.currentTurnOrdinal,
    completedThroughTurnOrdinal: data.completedThroughTurnOrdinal,
    currentStepOrdinal: data.currentStepOrdinal,
    nodes,
    cache: data.cache,
    retentionEvidence: [],
  };
}

/** Read local JSON only. Relative paths use the caller's working directory. */
export function loadFixture(path: string | URL): SessionSnapshot {
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    validateFixture(data);
    return snapshot(data);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Invalid fixture ${String(path)}: ${detail}`, { cause });
  }
}
