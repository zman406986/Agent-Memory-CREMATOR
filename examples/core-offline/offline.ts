// One offline run of the core: forget a tool result by path, then restore it byte-exactly by id.
// Run after `npm run build`:  node --experimental-strip-types examples/core-offline/offline.ts
import {
  CharHeuristicTokenMeter, DEFAULT_CONFIG, MemoryBlobStore, Meter, RacoonsEngine, SqliteLedger,
  concatBytes, createDefaultRules, equalBytes, sha256Sync,
} from '@cremator/core';
import type {
  ApplyReceipt, ApplyRequest, ApplyResult, ApplicationPort, CapabilityFlags, MessageNode,
  ReceiptLookup, SessionSnapshot, ToolResultNode, TranscriptNode,
} from '@cremator/core';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const body = encode('first line\nsecond line\nthird line\n');
const sha = sha256Sync(body), size = body.byteLength;
const result: ToolResultNode = { id: 'result-1', kind: 'tool-result', turnOrdinal: 1, stepOrdinal: 1,
  bytes: body, sha256: sha, byteLength: size, callId: 'call-1', embeddedRecords: [],
  evidence: { kind: 'read', target: { key: 'needle', label: 'needle' },
    source: { nodeId: 'result-1', sha256: sha, byteLength: size }, sourceRecallId: null,
    paths: [{ pathKey: 'src/needle.ts', displayPath: 'src/needle.ts', title: null,
      lineCount: 3, byteLength: size, outcome: 'hit' }] } };
// The entry needs its tool call in the snapshot, or the guard refuses "pairing-changed".
const callText = encode('Read src/needle.ts');
const call: MessageNode = { id: 'message-1', kind: 'message', role: 'assistant',
  bytes: callText, sha256: sha256Sync(callText), byteLength: callText.byteLength,
  turnOrdinal: 1, stepOrdinal: 0, toolCallIds: ['call-1'] };
const snapshot: SessionSnapshot = { sessionId: 'session-1', revision: 'revision-1',
  currentTurnOrdinal: 1, completedThroughTurnOrdinal: 0, currentStepOrdinal: 1, nodes: [call, result],
  cache: { kind: 'warm', watermarkNodeIndex: 0 }, retentionEvidence: [] };
const capabilities: CapabilityFlags = { mutateResult: true, rewriteHistory: true, atRest: true,
  liveTokens: false, log: true, appendRecords: true, rehydrateOnResume: false, revertHistory: true };
const clock = { nowMs: () => Date.now() };

/** The host half of the seam: it holds the transcript and applies what the guard approved. */
class InMemoryPort implements ApplicationPort {
  #live: SessionSnapshot;
  #receipts = new Map<string, ApplyReceipt>();

  constructor(live: SessionSnapshot) { this.#live = live; }

  async snapshot(): Promise<SessionSnapshot> { return structuredClone(this.#live); }

  async apply({ intent, application }: ApplyRequest): Promise<ApplyResult> {
    const revert = application.revert;
    if (revert !== undefined) {
      const records = new Map(application.appendRecords.map(record => [record.recordId, record]));
      const survivors = new Set(revert.survivors), nodes: TranscriptNode[] = [];
      const appendReceipts = (anchor: string | null): void => {
        for (const item of revert.appends) {
          const record = records.get(item.noteId);
          if ((item.afterNodeId ?? null) !== anchor || record === undefined) continue;
          nodes.push({ kind: 'racoons-record', id: record.recordId, recordId: record.recordId,
            turnOrdinal: this.#live.currentTurnOrdinal, stepOrdinal: this.#live.currentStepOrdinal,
            bytes: record.bytes.slice(), sha256: record.sha256, byteLength: record.bytes.length });
        }
      };
      // The prefix before the cut stays verbatim; each receipt lands after its anchor.
      appendReceipts(null);
      this.#live.nodes.forEach((node, index) => {
        if (index >= revert.cutIndex && !survivors.has(node.id)) return;
        nodes.push(node);
        appendReceipts(node.id);
      });
      this.#live = { ...this.#live, revision: `${this.#live.revision}+1`, nodes };
    }
    const receipt: ApplyReceipt = { ...intent, resultRevision: this.#live.revision,
      appliedAtMs: clock.nowMs() };
    this.#receipts.set(receipt.intentId, receipt);
    return { status: 'applied', receipt: structuredClone(receipt) };
  }

  async lookupReceipt(intentId: string): Promise<ReceiptLookup> {
    const receipt = this.#receipts.get(intentId);
    return receipt === undefined ? { status: 'unknown' }
      : { status: 'applied', receipt: structuredClone(receipt) };
  }
}

const ledger = await SqliteLedger.open({ databasePath: ':memory:',
  blobStore: new MemoryBlobStore(), clock });
const meter = new Meter(new CharHeuristicTokenMeter());
const port = new InMemoryPort(snapshot);
const engine = await RacoonsEngine.open({ sessionId: snapshot.sessionId, capabilities,
  config: DEFAULT_CONFIG, clock, meter, ledger, rules: createDefaultRules(DEFAULT_CONFIG), port });
// The human names a path; empty ranges mean the whole result. Core resolves the one unit.
const outcome = await engine.process({ kind: 'forget', eventId: 'event-1',
  request: { source: 'src/needle.ts', ranges: [], label: 'auth retry path' } });
const after = await port.snapshot();
const record = after.nodes.find(node => node.kind === 'racoons-record');
const receiptText = record === undefined ? '' : new TextDecoder().decode(record.bytes).trim();
const recallId = /necromancy (recall:sha256:[0-9a-f]{64})/.exec(receiptText)?.[1];
if (recallId === undefined) throw new Error(`No recall id in the receipt: ${receiptText}`);
// The receipt is all the transcript keeps; the bytes come back from the ledger by id alone.
const recalled = concatBytes(...(await engine.recall(recallId)).parts.map(part => part.bytes));
await ledger.close();

console.log('estimated tokens:', meter.estimate(body));
console.log('forget:', outcome.status);
console.log('receipt:', receiptText);
console.log('result still in transcript:', after.nodes.some(node => node.id === 'result-1'));
console.log('recalled', recalled.byteLength, 'bytes byte-exact:', equalBytes(recalled, body));
