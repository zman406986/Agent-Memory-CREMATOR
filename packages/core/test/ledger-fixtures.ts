import type { Bytes } from "../src/types/identity.js";
import { sha256 } from "../src/util/hash.js";
import {
  buildRecallManifest, manifestSha256, recallIdFor,
} from "../src/ledger/manifest.js";
import type { RecallPart, RecallRecord } from "../src/ledger/manifest.js";
import type { PreparableApplication } from "../src/ledger/types.js";

export const bytes = (text: string): Bytes => new TextEncoder().encode(text);

export async function recallFixture(
  bodies: readonly Bytes[] = [new Uint8Array([239, 187, 191, 0, 255, 13, 10, 195, 169])],
  sessionId = "session-1",
): Promise<RecallRecord> {
  const parts: RecallPart[] = [];
  for (const [index, body] of bodies.entries()) {
    const hash = await sha256(body);
    parts.push({
      source: { nodeId: `node-${index}`, sha256: hash, byteLength: body.byteLength },
      bytes: new Uint8Array(body),
      removedRanges: body.byteLength === 0 ? [] : [{
        range: { startByte: 0, endByteExclusive: body.byteLength }, sha256: hash,
      }],
    });
  }
  const manifest = buildRecallManifest(sessionId, parts.map(part => ({
    source: part.source, blobSha256: part.source.sha256, removedRanges: part.removedRanges,
  })));
  const hash = await manifestSha256(manifest);
  return { id: recallIdFor(hash), manifestSha256: hash, manifest, parts };
}

export async function applicationFixture(suppliedRecall?: RecallRecord): Promise<PreparableApplication> {
  const recall = suppliedRecall ?? await recallFixture();
  return {
    sessionId: recall.manifest.sessionId, eventId: "event-1", baseRevision: "revision-1",
    phase: "entry", applicationSha256: await sha256(bytes("guard-verified application")),
    archives: [{ ruleId: "cap", removalId: "removal-1", operationKind: "cap",
      episodeId: null, title: "Original body", recall }],
    appendRecords: [], sealedEpisodeIds: [],
  };
}
