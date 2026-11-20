import assert from 'node:assert/strict';
import type { ApplyRequest, ApplyResult, ApplicationPort, EngineOptions, ReceiptLookup } from '../src/engine/types.js';
import type { ValidatedApplication } from '../src/guard/types.js';
import type { ApplyReceipt, Ledger, LedgerEntry, LedgerEvent, PreparedIntent, RecallRecord } from '../src/ledger/types.js';
import { Meter } from '../src/meter/meter.js';
import type { PrunePassApplication } from '../src/prune/pass-merge.js';
import type { SessionSnapshot, ToolResultNode, TranscriptNode } from '../src/types/transcript.js';
import { UnitTracker } from '../src/units/tracker.js';
import { canonicalManifestBytes } from '../src/util/bytes.js';
import { sha256 } from '../src/util/hash.js';

export class TestLedger implements Ledger {
  readonly entries: LedgerEntry[] = [];
  readonly applications = new Map<string, ValidatedApplication>();
  readonly recalls = new Map<string, RecallRecord>();
  failPrepare = false;
  failApplied = false;

  async prepare(application: ValidatedApplication): Promise<PreparedIntent> {
    if (this.failPrepare) throw new Error('Injected archive failure');
    const intent: PreparedIntent = {
      intentId: `intent:sha256:${await sha256(canonicalManifestBytes([
        application.sessionId, application.eventId, application.applicationSha256,
      ]))}`,
      sessionId: application.sessionId, eventId: application.eventId,
      baseRevision: application.baseRevision, applicationSha256: application.applicationSha256,
    };
    this.applications.set(intent.intentId, structuredClone(application));
    for (const archive of application.archives) {
      this.recalls.set(archive.recall.id, structuredClone(archive.recall));
    }
    await this.append({ kind: 'prepared', sessionId: intent.sessionId,
      eventKey: `prepared:${intent.intentId}`, atMs: application.createdAtMs,
      intentId: intent.intentId, applicationSha256: intent.applicationSha256 });
    return intent;
  }

  async append(event: LedgerEvent): Promise<LedgerEntry> {
    if (event.kind === 'applied' && this.failApplied) throw new Error('Injected receipt write failure');
    const previous = this.entries.find(entry => entry.event.eventKey === event.eventKey);
    if (previous !== undefined) {
      assert.deepEqual(event, previous.event, 'event keys must have immutable contents');
      return structuredClone(previous);
    }
    const entry = { sequence: this.entries.length + 1, event: structuredClone(event) };
    this.entries.push(entry);
    return structuredClone(entry);
  }

  async *events(sessionId: string): AsyncIterable<LedgerEntry> {
    for (const entry of structuredClone(this.entries)) {
      if (entry.event.sessionId === sessionId) yield entry;
    }
  }

  async recall(id: string): Promise<RecallRecord> {
    const recall = this.recalls.get(id);
    if (recall === undefined) throw new Error('Recall not found');
    return structuredClone(recall);
  }

  async close(): Promise<void> {}
}

export class TestPort implements ApplicationPort {
  readonly requests: ApplyRequest[] = [];
  readonly receipts = new Map<string, ApplyReceipt>();
  outcome: 'applied' | 'not-applied' | 'unknown' | 'throw' = 'applied';
  // Absence from the fake's map is unknown, never a refusal (ISSUE-030 R1); a
  // test needing a confirmed refusal sets this explicitly.
  lookup: 'not-applied' | 'unknown' = 'unknown';
  beforeApply: (() => void) | undefined;

  live: SessionSnapshot;
  incoming: ToolResultNode;

  constructor(live: SessionSnapshot, incoming: ToolResultNode) {
    this.live = live;
    this.incoming = incoming;
  }

  async snapshot(): Promise<SessionSnapshot> { return structuredClone(this.live); }

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    this.requests.push(structuredClone(request));
    this.beforeApply?.();
    const existing = this.receipts.get(request.intent.intentId);
    if (existing !== undefined) return { status: 'applied', receipt: structuredClone(existing) };
    if (this.outcome === 'throw') throw new Error('Host response lost');
    if (this.outcome === 'unknown') return { status: 'unknown' };
    if (this.outcome === 'not-applied') return { status: 'not-applied', reason: 'host-error' };
    if (request.intent.baseRevision !== this.live.revision) {
      return { status: 'not-applied', reason: 'stale-revision' };
    }
    const { application } = request;
    const revert = application.revert;
    if (revert !== undefined) {
      this.applyRevert(application, revert);
    } else {
      const nodes: TranscriptNode[] = structuredClone([...this.live.nodes]);
      for (const replacement of application.replacements) {
        const index = nodes.findIndex(node => node.id === replacement.source.nodeId);
        const original = index < 0 ? this.incoming : nodes[index];
        assert.ok(original?.kind === 'tool-result');
        assert.equal(original.sha256, replacement.source.sha256);
        const updated: ToolResultNode = {
          ...original, bytes: replacement.bytes.slice(), sha256: replacement.sha256,
          byteLength: replacement.bytes.length, embeddedRecords: replacement.generatedRanges,
          evidence: { ...original.evidence, sourceRecallId: replacement.evidenceRecallId },
        };
        if (index < 0) nodes.push(updated); else nodes[index] = updated;
      }
      for (const record of application.appendRecords) {
        assert.ok(!nodes.some(node => node.kind === 'racoons-record' && node.recordId === record.recordId));
        nodes.push({ kind: 'racoons-record', id: record.recordId, recordId: record.recordId,
          turnOrdinal: this.live.currentTurnOrdinal, stepOrdinal: this.live.currentStepOrdinal,
          bytes: record.bytes.slice(), sha256: record.sha256, byteLength: record.bytes.length });
      }
      this.live = { ...this.live, revision: `${this.live.revision}+1`, nodes };
    }
    const receipt: ApplyReceipt = { ...request.intent,
      resultRevision: this.live.revision, appliedAtMs: 100 };
    this.receipts.set(receipt.intentId, receipt);
    return { status: 'applied', receipt: structuredClone(receipt) };
  }

  /**
   * A checkpoint-revert as the host applies it: the prefix before the cut stays
   * verbatim, survivors follow in order, and each receipt lands after its
   * anchor. Forgotten nodes and everything after the cut that they replaced
   * leave the transcript, exactly as the approved plan says.
   */
  private applyRevert(application: ValidatedApplication, revert: NonNullable<ValidatedApplication['revert']>): void {
    const records = new Map(application.appendRecords.map(record => [record.recordId, record]));
    const survivors = new Set(revert.survivors);
    const ordered = [...this.live.nodes];
    for (const append of revert.appends) {
      const record = records.get(append.noteId);
      assert.ok(record !== undefined, `revert append names record ${append.noteId}`);
    }
    const nodes: TranscriptNode[] = [];
    const pushReceipt = (anchor: string | null): void => {
      for (const append of revert.appends) {
        if ((append.afterNodeId ?? null) !== anchor) continue;
        const record = records.get(append.noteId);
        assert.ok(record !== undefined);
        nodes.push({ kind: 'racoons-record', id: record.recordId, recordId: record.recordId,
          turnOrdinal: this.live.currentTurnOrdinal, stepOrdinal: this.live.currentStepOrdinal,
          bytes: record.bytes.slice(), sha256: record.sha256, byteLength: record.bytes.length });
      }
    };
    pushReceipt(null);
    ordered.forEach((node, index) => {
      const keep = index < revert.cutIndex || survivors.has(node.id);
      if (!keep) return;
      nodes.push(node);
      pushReceipt(node.id);
    });
    this.live = { ...this.live, revision: `${this.live.revision}+1`, nodes,
      cache: { kind: 'warm', watermarkNodeIndex: revert.cutIndex } };
  }

  async lookupReceipt(intentId: string): Promise<ReceiptLookup> {
    const receipt = this.receipts.get(intentId);
    return receipt === undefined ? { status: this.lookup }
      : { status: 'applied', receipt: structuredClone(receipt) };
  }
}

/**
 * The applied-removal fixture. The entry-time cap has no application path any
 * more (ADR-0014, 2026-10-23), and the per-unit judge lane is gone (ADR-0028),
 * so the product's one removal path drives it: one bulk-prune pass lists both
 * above-bar units, forgets the first and keeps the second (ADR-0009). `present`
 * is an ordinary boundary the rules see; `prune` is the pass's apply leg and
 * applies one checkpoint-revert. `entry` carries the forgotten node's bytes for
 * refetch measurements.
 */
export async function fixture() {
  const base = await protocolFixture();
  const first = base.units[0], second = base.units[1];
  if (first === undefined || second === undefined) throw new Error('Fixture units missing');
  const document: PrunePassApplication = {
    removals: [{ unitId: first.id, origin: 'l2', action: 'forgetall',
      summary: 'auth retry path', answeredInRound: 1 }],
    kept: [second.id], refused: [], rejected: [],
  };
  return {
    ledger: base.ledger, port: base.port, options: base.options, snapshot: base.snapshot,
    units: base.units, first: base.first, second: base.second,
    present: base.atRest,
    prune: { kind: 'prune' as const, eventId: 'prune-1', round: 1,
      verdicts: document, window: 200_000 },
    entry: { kind: 'entry' as const, eventId: 'entry-1', result: base.first },
  };
}

/** One above-bar tool result in the protocol fixture, with a hit path for its receipt. */
async function protocolResult(
  index: number, turnOrdinal: number, stepOrdinal: number,
): Promise<ToolResultNode> {
  const bytes = new TextEncoder().encode(`src/file-${index}.ts result body\n`.repeat(4));
  const hash = await sha256(bytes);
  return {
    kind: 'tool-result', id: `result-${index}`, turnOrdinal, stepOrdinal,
    bytes, sha256: hash, byteLength: bytes.length, callId: `call-${index}`, embeddedRecords: [],
    evidence: {
      kind: 'read', target: null, source: { nodeId: `result-${index}`, sha256: hash, byteLength: bytes.length },
      sourceRecallId: null,
      paths: [{ pathKey: `src/file-${index}.ts`, displayPath: `src/file-${index}.ts`,
        title: null, lineCount: 4, byteLength: bytes.length, outcome: 'hit' }],
    },
  };
}

/**
 * A settled-history session with two above-bar results, both past the in-flight
 * turn so neither is protected. `barBytes` is 8, so both yield one unit each.
 * The bar is read by the prune planner and the guard alike.
 */
export async function protocolFixture() {
  const [first, second] = [await protocolResult(1, 1, 1), await protocolResult(2, 1, 2)];
  const messageBytes = new TextEncoder().encode('Read two files');
  const snapshot: SessionSnapshot = {
    sessionId: 'session-1', revision: 'revision-1', currentTurnOrdinal: 2,
    completedThroughTurnOrdinal: 1, currentStepOrdinal: 3,
    nodes: [
      { kind: 'message', id: 'assistant-1', role: 'assistant', toolCallIds: ['call-1', 'call-2'],
        turnOrdinal: 1, stepOrdinal: 0, bytes: messageBytes,
        sha256: await sha256(messageBytes), byteLength: messageBytes.length },
      first, second,
    ],
    cache: { kind: 'warm', watermarkNodeIndex: 0 }, retentionEvidence: [],
  };
  const ledger = new TestLedger();
  const incoming = await protocolResult(9, 1, 9);
  const port = new TestPort(snapshot, incoming);
  const options: EngineOptions = {
    sessionId: snapshot.sessionId, port, ledger, clock: { nowMs: () => 100 },
    meter: new Meter({ estimate: content => content.length }), rules: [],
    capabilities: { mutateResult: true, rewriteHistory: false, atRest: true,
      liveTokens: false, log: true, appendRecords: true, rehydrateOnResume: false,
      revertHistory: true },
    config: {
      thresholds: { capBytes: 1024 * 1024, capHeadBytes: null, episodeNoNewPathSteps: null,
        sealMaxLatencyTurns: 1 },
      freshZone: { maxNodes: null, maxBytes: null }, sealMode: 'append',
      validationFailureLimit: 2,
      protocol: { barBytes: 8, minCutFreedBytes: 4096 },
    },
  };
  const units = new UnitTracker({ sessionId: snapshot.sessionId, barBytes: 8 }).units(snapshot);
  const atRest = { kind: 'at-rest' as const, eventId: 'at-rest-1', reason: 'step' as const };
  return { ledger, port, options, snapshot, units, first, second, atRest };
}
