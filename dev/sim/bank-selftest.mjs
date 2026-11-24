#!/usr/bin/env node
// Public-seam bank selftest (ISSUE-020 chunk 2).
//
// The v4 simulation harness kept a memory bank beside gitignored scratchpad
// code: it rebuilt recall manifests from dist modules and served archives from
// its own Maps. Core has since promoted the durable pair (`SqliteLedger` +
// `FileBlobStore`) and the epoch helpers. This file re-expresses the bank
// checks against that public seam and nothing else:
//
//   archive  = a verdict application the shipped `Guard` approved
//   persist  = `SqliteLedger.prepare` into a real sqlite file + blob directory
//   restore  = `SqliteLedger.recall`, the product's verifying read path
//   receipt  = the guard's appended record and the shipped `receiptLine`
//
// Every import below is a public `@cremator/core` export. There is no dist path,
// no relative core-source import, and no scratchpad import. Run by hand:
//
//   node dev/sim/bank-selftest.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileBlobStore, Guard, LedgerError, SqliteLedger, UnitTracker, VerdictTracker,
  applyPruneAnswers, fromBytes, planPrunePass, planVerdictApplication, receiptLine,
  sha256Sync, toBytes,
} from "@cremator/core";

const SESSION = "sim:bank-selftest";
const BAR_BYTES = 8;
const FIXTURE_PATH = "src/sim-fixture.ts";

const CONFIG = {
  thresholds: {
    capBytes: 8,
    capHeadBytes: null,
    episodeNoNewPathSteps: null,
    sealMaxLatencyTurns: 1,
    evictAfterClosedTurns: null,
  },
  freshZone: { maxNodes: null, maxBytes: null },
  sealMode: "append",
  enableSpans: false,
  validationFailureLimit: 2,
  protocol: {
    barBytes: BAR_BYTES,
    advertisedLabelLimit: 40,
    retryLimit: 2,
    minCutFreedBytes: 4096,
    revisitShare: 0.5,
  },
};

const CAPABILITIES = {
  mutateResult: true,
  rewriteHistory: false,
  atRest: true,
  liveTokens: false,
  log: true,
  appendRecords: true,
  rehydrateOnResume: false,
  revertHistory: true,
};

// The guard only asks this ledger for evidence recalls, and a verdict scene
// carries none. A call here would be a fixture bug, so it fails loudly.
const NO_LEDGER = {
  prepare: async () => { throw new Error("guard must not prepare"); },
  append: async () => { throw new Error("guard must not append"); },
  events: async function* () { throw new Error("guard must not read events"); },
  recall: async () => { throw new Error("guard must not recall"); },
  close: async () => {},
};

const UNICODE_TEXT = [
  "intro — канonical",
  "línea dos · 日本語のテキスト",
  "emoji 🦝 and a tab\there",
  "tail line without newline",
].join("\n");

const SIX_LINES = Array.from({ length: 6 }, (_, index) =>
  `line ${index + 1}${index === 2 ? " — ünïcode 🦝" : ""}`).join("\n");

function toolResultNode(text, { id = "result", step = 1 } = {}) {
  const bytes = toBytes(text);
  const hash = sha256Sync(bytes);
  return {
    id,
    kind: "tool-result",
    turnOrdinal: 1,
    stepOrdinal: step,
    bytes,
    sha256: hash,
    byteLength: bytes.byteLength,
    callId: `call-${id}`,
    embeddedRecords: [],
    evidence: {
      kind: "read",
      target: null,
      source: { nodeId: id, sha256: hash, byteLength: bytes.byteLength },
      sourceRecallId: null,
      paths: [{
        pathKey: FIXTURE_PATH,
        displayPath: FIXTURE_PATH,
        title: null,
        lineCount: text.split("\n").length,
        byteLength: bytes.byteLength,
        outcome: "hit",
      }],
    },
  };
}

function assistantNode() {
  const bytes = toBytes("assistant bytes");
  return {
    id: "assistant",
    kind: "message",
    role: "assistant",
    bytes,
    sha256: sha256Sync(bytes),
    byteLength: bytes.byteLength,
    turnOrdinal: 1,
    stepOrdinal: 0,
    toolCallIds: ["call-result"],
  };
}

function snapshotFor(sessionId, node) {
  return {
    sessionId,
    revision: "revision-1",
    currentTurnOrdinal: 2,
    completedThroughTurnOrdinal: 1,
    currentStepOrdinal: 2,
    nodes: [assistantNode(), node],
    cache: { kind: "warm", watermarkNodeIndex: 0 },
    retentionEvidence: [],
  };
}

/**
 * One verdict scene: a single above-bar tool result, answered `forgetall` or
 * `keeplines`, travelling the shipped product path and nothing else.
 *
 * The judge lane's own `kind: "verdict"` event was removed (ADR-0028): the
 * bulk prune is the one per-unit answer seam, and `Guard` refuses any
 * application phase that is not entry/at-rest/prune/forget
 * (`guard/checks-input.ts`). So the scene runs the pass exactly as the mount
 * does — `planPrunePass` numbers the row, `applyPruneAnswers` reads the answer
 * text into the decision document, and the shipped planner turns that document
 * into the operations the guard re-derives. Returns the approved application
 * (its archive holds the recall id).
 */
async function approvedApplication({ sessionId, text, verdict }) {
  const node = toolResultNode(text);
  const snapshot = snapshotFor(sessionId, node);
  const units = new UnitTracker({ sessionId, barBytes: BAR_BYTES }).units(snapshot);
  assert.equal(units.length, 1, "fixture must produce exactly one unit");
  const unit = units[0];
  assert.ok(unit !== undefined, "fixture unit must exist");

  // The pass's own plan: L1 and the dedupe prove nothing here, so the one unit
  // is numbered 1 and offered as row 1.
  const pass = planPrunePass({
    units, nodes: snapshot.nodes, episodes: [], round: 1, classes: {},
  });
  assert.equal(pass.askRows.length, 1, "the fixture's one unit must be the one ask row");
  assert.equal(pass.askRows[0].index, 1, "the pass must number its one row from 1");

  const document = applyPruneAnswers(
    pass,
    [wireAnswer(verdict)],
    { indices: [1], stamps: pass.stamps },
  );
  assert.equal(document.removals.length, 1, "the answer must produce one removal");
  assert.equal(document.refused.length, 0, "the answer must be read, not refused");

  // The state the engine builds from the document's removals: `pruneVerdicts`
  // reads each L2 removal back as the verdict its answer claimed.
  const tracker = new VerdictTracker({ units, round: pass.round });
  for (const removal of document.removals) {
    if (removal.origin !== "l2") continue;
    const accepted = tracker.judge(removal.action === "forgetall"
      ? { unitId: removal.unitId, action: "forgetall", summary: removal.summary,
          answeredInRound: removal.answeredInRound }
      : { unitId: removal.unitId, action: removal.action, ranges: removal.ranges,
          answeredInRound: removal.answeredInRound });
    assert.equal(accepted.status, "accepted", "the tracker must accept the document's removal");
  }
  const state = tracker.state();
  const plan = planVerdictApplication({
    state,
    baseRevision: snapshot.revision,
    nodes: snapshot.nodes,
  });
  assert.ok(plan !== null, "the planner must produce a verdict plan");

  const validation = await new Guard({
    ledger: NO_LEDGER,
    initialState: { consecutiveValidationFailures: 0, disabled: false },
  }).validate({
    input: {
      kind: "prune", eventId: "sim-event", round: pass.round, verdicts: document,
      window: 200_000,
    },
    snapshot,
    capabilities: CAPABILITIES,
    config: CONFIG,
    plans: [plan],
    sealedEpisodeIds: [],
    nowMs: 10,
  });
  assert.equal(validation.ok, true,
    `the guard must approve the scene: ${JSON.stringify(validation.issues ?? [])}`);
  const application = validation.application;
  assert.equal(application.archives.length, 1, "one archive per forgotten unit");
  assert.equal(application.appendRecords.length, 1, "one receipt per archive");
  return { application, node, unit, plan };
}

/**
 * One verdict as the wire answer text the mock would have served, so the scene
 * enters the product through the shipped parser rather than a hand-built
 * object. The grammar is v4.1's (ADR-0026 §2): `forgetall` carries its summary
 * as the value, `keeplines` an array of `[start,end]` pairs plus a trailer.
 */
function wireAnswer(verdict) {
  if (verdict.action === "forgetall") {
    return JSON.stringify({ 1: { forgetall: verdict.summary ?? "" } });
  }
  if (verdict.action === "keeplines") {
    return JSON.stringify({
      1: { keeplines: [...verdict.ranges.map(range => [range.from, range.to]), "kept the middle"] },
    });
  }
  throw new Error(`fixture scripts an unsupported action ${String(verdict.action)}`);
}

/** A FileBlobStore that can serve one hash back corrupted, after publication. */
function tamperableStore(root) {
  const inner = new FileBlobStore(root);
  let target = null;
  return {
    store: {
      put: bytes => inner.put(bytes),
      async get(hash) {
        const bytes = await inner.get(hash);
        if (hash !== target) return bytes;
        const damaged = new Uint8Array(bytes);
        damaged[0] ^= 0xff;
        return damaged;
      },
    },
    tamper(hash) { target = hash; },
  };
}

async function withLedger(body) {
  const root = mkdtempSync(join(tmpdir(), "racoons-bank-sim-"));
  const tampering = tamperableStore(join(root, "blobs"));
  const ledger = await SqliteLedger.open({
    databasePath: join(root, "ledger.sqlite"),
    blobStore: tampering.store,
    clock: { nowMs: () => 1_000 },
  });
  try {
    return await body({ ledger, tampering, root });
  } finally {
    await ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
}

let passed = 0;
const failures = [];

async function check(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`NOT OK - ${name}`);
    console.log(`  ${error?.message ?? error}`);
  }
}

// Two halves, and the name says which: the archived bytes agree with the node's
// bytes (renderer agreement: both come from the same renderer), and the real
// SqliteLedger + FileBlobStore round-trip returns them byte for byte (the
// restore check). A renderer bug passes the first half and fails the second.
await check("restore round-trips the archived bytes through SqliteLedger + FileBlobStore", async () => {
  await withLedger(async ({ ledger, root }) => {
    const { application, node } = await approvedApplication({
      sessionId: SESSION,
      text: UNICODE_TEXT,
      verdict: { action: "forgetall", summary: "notes" },
    });
    const recallId = application.archives[0].recall.id;

    const intent = await ledger.prepare(application);
    assert.equal(intent.sessionId, SESSION);
    assert.equal(existsSync(join(root, "ledger.sqlite")), true, "a real sqlite file must exist");

    const restored = await ledger.recall(recallId);
    assert.equal(restored.id, recallId);
    assert.equal(restored.manifest.sessionId, SESSION);
    assert.equal(restored.parts.length, 1);

    const part = restored.parts[0];
    assert.deepEqual(part.bytes, node.bytes);
    assert.equal(fromBytes(part.bytes), UNICODE_TEXT);
    assert.equal(sha256Sync(part.bytes), node.sha256);
    assert.equal(part.source.nodeId, node.id);
    assert.equal(part.source.sha256, node.sha256);
    assert.equal(part.source.byteLength, node.byteLength);
  });
});

await check("restore re-verifies the archived removed spans", async () => {
  await withLedger(async ({ ledger }) => {
    const { application, node } = await approvedApplication({
      sessionId: SESSION,
      text: SIX_LINES,
      verdict: { action: "keeplines", ranges: [{ from: 3, to: 4 }] },
    });
    const recall = application.archives[0].recall;
    await ledger.prepare(application);

    const restored = await ledger.recall(recall.id);
    const spans = restored.parts[0].removedRanges;
    assert.equal(spans.length, 2, "keeping lines 3–4 removes 1–2 and 5–6");
    for (const span of spans) {
      const slice = node.bytes.slice(span.range.startByte, span.range.endByteExclusive);
      assert.equal(sha256Sync(slice), span.sha256);
    }
    assert.equal(
      fromBytes(node.bytes.slice(spans[0].range.startByte, spans[0].range.endByteExclusive)),
      "line 1\nline 2\n",
    );
  });
});

await check("a multi-range receipt renders through the shipped template", async () => {
  const { application, plan } = await approvedApplication({
    sessionId: SESSION,
    text: SIX_LINES,
    verdict: { action: "keeplines", ranges: [{ from: 3, to: 4 }] },
  });
  const note = plan.notes[0];
  const recallId = application.archives[0].recall.id;

  const rendered = fromBytes(application.appendRecords[0].bytes);
  const direct = receiptLine({
    path: note.path,
    ranges: note.ranges,
    label: note.label,
    recallId,
  });
  assert.equal(rendered, direct);
  assert.equal(
    rendered.replace(recallId, "r1"),
    `[not retained] ${FIXTURE_PATH} lines 1–2, 5–6 · necromancy r1`,
  );
  assert.deepEqual(note.ranges, [
    { startLine: 1, endLineInclusive: 2 },
    { startLine: 5, endLineInclusive: 6 },
  ]);
});

await check("a whole-unit receipt renders the floor shape with its descriptor", async () => {
  const { application, plan } = await approvedApplication({
    sessionId: SESSION,
    text: UNICODE_TEXT,
    verdict: { action: "forgetall", summary: "config defaults" },
  });
  const recallId = application.archives[0].recall.id;
  const rendered = fromBytes(application.appendRecords[0].bytes);
  assert.deepEqual(plan.notes[0].ranges, []);
  assert.equal(rendered, receiptLine({
    path: FIXTURE_PATH, ranges: [], label: "config defaults", recallId,
  }));
  assert.equal(
    rendered.replace(recallId, "r1"),
    `[not retained] ${FIXTURE_PATH} — about: config defaults · necromancy r1`,
  );
});

await check("an unknown recall id refuses with a typed not-found LedgerError", async () => {
  await withLedger(async ({ ledger }) => {
    const absent = `recall:sha256:${"0".repeat(64)}`;
    for (const id of [absent, "recall:example", "not-an-id"]) {
      await assert.rejects(() => ledger.recall(id), (error) => {
        assert.ok(error instanceof LedgerError, "must be the shipped LedgerError");
        assert.equal(error.code, "not-found");
        assert.match(error.message, /Invalid recall id|Missing recall/u);
        return true;
      }, id);
    }
  });
});

await check("a tampered body refuses with hash-mismatch", async () => {
  await withLedger(async ({ ledger, tampering }) => {
    const { application, node } = await approvedApplication({
      sessionId: SESSION,
      text: UNICODE_TEXT,
      verdict: { action: "forgetall", summary: null },
    });
    await ledger.prepare(application);
    tampering.tamper(node.sha256);
    await assert.rejects(() => ledger.recall(application.archives[0].recall.id), (error) => {
      assert.ok(error instanceof LedgerError);
      assert.equal(error.code, "hash-mismatch");
      return true;
    });
  });
});

await check("a recall survives closing and reopening the ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "racoons-bank-sim-"));
  const databasePath = join(root, "ledger.sqlite");
  const blobRoot = join(root, "blobs");
  const open = () => SqliteLedger.open({
    databasePath,
    blobStore: new FileBlobStore(blobRoot),
    clock: { nowMs: () => 2_000 },
  });
  const first = await open();
  try {
    const { application, node } = await approvedApplication({
      sessionId: SESSION,
      text: UNICODE_TEXT,
      verdict: { action: "forgetall", summary: "notes" },
    });
    const recallId = application.archives[0].recall.id;
    await first.prepare(application);
    await first.close();

    const second = await open();
    try {
      const restored = await second.recall(recallId);
      assert.deepEqual(restored.parts[0].bytes, node.bytes);
      assert.equal(fromBytes(restored.parts[0].bytes), UNICODE_TEXT);
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
    rmSync(root, { recursive: true, force: true });
  }
});

await check("the same bytes under the same session keep one recall id", async () => {
  const scene = { text: UNICODE_TEXT, verdict: { action: "forgetall", summary: "notes" } };
  const first = await approvedApplication({ sessionId: SESSION, ...scene });
  const second = await approvedApplication({ sessionId: SESSION, ...scene });
  const other = await approvedApplication({ sessionId: "sim:other-session", ...scene });

  const firstId = first.application.archives[0].recall.id;
  assert.match(firstId, /^recall:sha256:[0-9a-f]{64}$/u);
  assert.equal(second.application.archives[0].recall.id, firstId);
  assert.notEqual(other.application.archives[0].recall.id, firstId);
  assert.equal(
    first.application.archives[0].recall.manifestSha256,
    second.application.archives[0].recall.manifestSha256,
  );
});

await check("the restore serves private copies on every read", async () => {
  await withLedger(async ({ ledger }) => {
    const { application } = await approvedApplication({
      sessionId: SESSION,
      text: UNICODE_TEXT,
      verdict: { action: "forgetall", summary: "notes" },
    });
    const recallId = application.archives[0].recall.id;
    await ledger.prepare(application);

    const first = await ledger.recall(recallId);
    first.parts[0].bytes[0] ^= 0xff;
    const second = await ledger.recall(recallId);
    assert.equal(fromBytes(second.parts[0].bytes), UNICODE_TEXT);
  });
});

console.log("");
if (failures.length > 0) {
  console.log(`FAIL ${failures.length} of ${passed + failures.length} checks (public seam)`);
  process.exitCode = 1;
} else {
  console.log(`PASS ${passed}/${passed} checks (public seam)`);
}
