import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RacoonsEngine } from '../src/engine/engine.js';
import type { EngineInput, ForgetRequest } from '../src/engine/types.js';
import type { SessionSnapshot, ToolResultNode } from '../src/types/transcript.js';
import { sha256Sync } from '../src/util/hash.js';
import { protocolFixture } from './engine-fixtures.js';

/**
 * A manual forget (PRD §6.2; ISSUE-045 chunk C1): the human names a path and
 * the lines they want gone. Core resolves it to the one unit that holds those
 * lines, plans it in the verdict lane's shapes under the `forget` rule id, and
 * applies it through the same guard and checkpoint-revert every removal uses.
 *
 * These tests are the chunk's acceptance set. The negative cases matter most:
 * a request that resolves to nothing removes nothing, and a host without the
 * revert seam applies nothing — absence of authority never becomes a guess.
 */
function forget(eventId: string, request: ForgetRequest): EngineInput {
  return { kind: 'forget', eventId, request };
}

/** The receipt a forget appends, by kind: one `racoons-record` node. */
function receipts(snapshot: SessionSnapshot) {
  return snapshot.nodes.filter(node => node.kind === 'racoons-record');
}

/**
 * One row per way a forget request can land. The applied row is the only one
 * that may change the transcript; every refusal row asserts the same three
 * things — the status, the code, and that the live transcript is byte-identical
 * to the one the request arrived on. A row that only checked its status would
 * pass on an engine that refused loudly and mutated anyway.
 */
const CASES: readonly {
  readonly name: string;
  /** Extra setup on the fixture before the request is sent. */
  readonly setup?: (f: Awaited<ReturnType<typeof protocolFixture>>) => void;
  /** Overrides the engine options for this row. */
  readonly options?: (f: Awaited<ReturnType<typeof protocolFixture>>) =>
    Awaited<ReturnType<typeof protocolFixture>>['options'];
  readonly request: ForgetRequest;
  readonly run: (scene: Scene) => Promise<void>;
}[] = [
  {
    name: 'a forget of held lines yields one revert and one receipt',
    request: { source: 'src/file-1.ts', ranges: [{ startLine: 1, endLineInclusive: 2 }],
      label: 'auth retry path' },
    run: async ({ f, engine, outcome }: Scene) => {
      const name = CASES[0]?.name as string;
      assert.equal(outcome.status, 'applied', `row: ${name} — a request the agent holds applies`);
      // Exactly one host application, and it is a checkpoint-revert: the unit's
      // bytes leave the transcript and a receipt takes their place.
      assert.equal(f.port.requests.length, 1, `row: ${name} — one host application, no more`);
      const application = f.port.requests[0]?.application;
      assert.ok(application !== undefined, `row: ${name} — the application reached the port`);
      assert.equal(application.mode, 'revert', `row: ${name} — a forget is a checkpoint-revert`);
      assert.deepEqual(application.revert?.unitIds, [f.units[0]?.id],
        `row: ${name} — the revert names exactly the unit that held the lines`);
      assert.equal(application.appendRecords.length, 1, `row: ${name} — one receipt record`);
      assert.equal(application.archives.length, 1, `row: ${name} — one archive`);
      assert.equal(application.archives[0]?.ruleId, 'forget',
        `row: ${name} — the archive is filed under the forget rule id`);
      const after = f.port.live;
      assert.equal(after.nodes.some(node => node.id === 'result-1'), false,
        `row: ${name} — the forgotten result left the transcript`);
      assert.equal(after.nodes.some(node => node.id === 'result-2'), true,
        `row: ${name} — the kept result survived`);
      assert.equal(receipts(after).length, 1, `row: ${name} — exactly one receipt node was added`);
      // The original bytes are restorable byte-exactly by the receipt's recall id.
      const recallId = application.archives[0]?.recall.id;
      assert.ok(recallId !== undefined, `row: ${name} — the archive carries a recall id`);
      assert.deepEqual((await engine.recall(recallId)).parts[0]?.bytes, f.first.bytes,
        `row: ${name} — the forgotten bytes are restorable byte-exactly`);
      // The guard approved the plan: no refusal was recorded for this event.
      const refused = f.ledger.entries.filter(({ event }) => event.kind === 'validation'
        && event.eventId === 'forget-1' && !event.ok);
      assert.deepEqual(refused, [], `row: ${name} — the guard recorded no refusal for an applied forget`);
    },
  },
  {
    name: 'a forget of lines the agent does not hold is refused and changes nothing',
    request: { source: 'src/file-1.ts', ranges: [{ startLine: 900, endLineInclusive: 901 }],
      label: null },
    run: async ({ f, outcome, before, name }: Scene & { readonly name: string }) => {
      assert.equal(outcome.status, 'rejected', `row: ${name} — lines nothing holds are a refusal`);
      assert.deepEqual(outcome.validation?.ok === false
        ? outcome.validation.issues.map(issue => issue.code) : [], ['unresolved-request'],
        `row: ${name} — the refusal names the unresolved request`);
      assert.equal(f.port.requests.length, 0, `row: ${name} — a refusal applies nothing`);
      assert.deepEqual(f.port.live, before, `row: ${name} — the transcript is unchanged`);
      assert.equal(f.ledger.recalls.size, 0, `row: ${name} — a refusal banks no archive`);
    },
  },
  {
    name: 'a request two held units answer is ambiguous, and nothing is guessed',
    setup: f => {
      // A second read of the same path: both results hold the requested line.
      const duplicate = { ...f.second, id: 'result-3', callId: 'call-3' };
      f.port.live = { ...f.port.live, nodes: [...f.port.live.nodes, duplicate] };
    },
    request: { source: 'src/file-2.ts', ranges: [{ startLine: 1, endLineInclusive: 1 }], label: null },
    run: async ({ f, outcome, before, name }) => {
      assert.equal(outcome.status, 'rejected', `row: ${name} — two candidates are a refusal`);
      const issues = outcome.validation?.ok === false ? outcome.validation.issues : [];
      assert.equal(issues.some(issue => issue.code === 'unresolved-request'
        && issue.detail.includes('2 held units')), true,
      `row: ${name} — the refusal names the count rather than picking one, got ${JSON.stringify(issues)}`);
      assert.equal(f.port.requests.length, 0, `row: ${name} — an ambiguity applies nothing`);
      assert.deepEqual(f.port.live, before, `row: ${name} — the transcript is unchanged`);
    },
  },
  {
    name: 'a forget backed only by grep output is refused: no file-content unit exists',
    setup: f => {
      // ISSUE-327: a search hit names a path whose file content was never read.
      // The grep output is not a copy of the file, so a file-content forget of
      // that path must resolve to nothing.
      const bytes = new TextEncoder().encode('grep line one\ngrep line two\n');
      const hash = sha256Sync(bytes);
      const grep: ToolResultNode = {
        kind: 'tool-result', id: 'result-grep', turnOrdinal: 1, stepOrdinal: 3,
        bytes, sha256: hash, byteLength: bytes.length, callId: 'call-grep', embeddedRecords: [],
        evidence: {
          kind: 'search', target: { key: 'needle', label: 'needle' },
          source: { nodeId: 'result-grep', sha256: hash, byteLength: bytes.length },
          sourceRecallId: null,
          paths: [{ pathKey: 'src/grep-only.ts', displayPath: 'src/grep-only.ts',
            title: null, lineCount: 2, byteLength: bytes.length, outcome: 'hit' }],
        },
      };
      f.port.live = {
        ...f.port.live,
        nodes: [...f.port.live.nodes.map(node => node.kind === 'message'
          ? { ...node, toolCallIds: [...node.toolCallIds, grep.callId] } : node), grep],
      };
    },
    request: { source: 'src/grep-only.ts', ranges: [{ startLine: 1, endLineInclusive: 2 }],
      label: null },
    run: async ({ f, outcome, before, name }: Scene & { readonly name: string }) => {
      assert.equal(outcome.status, 'rejected',
        `row: ${name} — grep output is not file content, so the request resolves to nothing`);
      assert.deepEqual(outcome.validation?.ok === false
        ? outcome.validation.issues.map(issue => issue.code) : [], ['unresolved-request'],
        `row: ${name} — the refusal names the unresolved request`);
      assert.equal(f.port.requests.length, 0, `row: ${name} — a refusal applies nothing`);
      assert.deepEqual(f.port.live, before, `row: ${name} — the transcript is unchanged`);
      assert.equal(f.ledger.recalls.size, 0, `row: ${name} — a refusal banks no archive`);
      assert.equal(receipts(f.port.live).length, 0,
        `row: ${name} — no receipt names the grep-only path`);
    },
  },
];

test('forget requests — one row per way a request can land', async () => {
  for (const row of CASES) {
    const f = await protocolFixture();
    row.setup?.(f);
    const engine = await RacoonsEngine.open(row.options?.(f) ?? f.options);
    const before = structuredClone(f.port.live);
    const outcome = await engine.process(forget(`forget-${String(CASES.indexOf(row) + 1)}`, row.request));
    try {
      await row.run({ f, engine, outcome, before, name: row.name });
    } catch (error) {
      throw new Error(`row: ${row.name} — ${error instanceof Error ? error.message : String(error)}`,
        { cause: error });
    }
  }
});

/** What one row is handed: the fixture, its engine, the outcome, and the prior transcript. */
interface Scene {
  readonly f: Awaited<ReturnType<typeof protocolFixture>>;
  readonly engine: RacoonsEngine;
  readonly outcome: Awaited<ReturnType<RacoonsEngine['process']>>;
  readonly before: SessionSnapshot;
  readonly name: string;
}

test('a forget without the revert seam records unsupported-capability and applies nothing', async () => {
  const name = 'a forget without the revert seam records unsupported-capability and applies nothing';
  const f = await protocolFixture();
  const engine = await RacoonsEngine.open({ ...f.options,
    capabilities: { ...f.options.capabilities, revertHistory: false } });
  const before = structuredClone(f.port.live);
  const outcome = await engine.process(forget('forget-4', {
    source: 'src/file-1.ts', ranges: [], label: null,
  }));
  assert.equal(outcome.status, 'rejected', `row: ${name} — a host without the seam is refused`);
  const issues = outcome.validation?.ok === false ? outcome.validation.issues : [];
  assert.deepEqual(issues.map(issue => issue.code), ['unsupported-capability'],
    `row: ${name} — the refusal names the missing capability and nothing else`);
  assert.equal(issues[0]?.detail.includes('revert seam'), true,
    `row: ${name} — the detail names the revert seam`);
  assert.equal(f.port.requests.length, 0, `row: ${name} — no application is sent`);
  assert.deepEqual(f.port.live, before, `row: ${name} — the transcript is unchanged`);
  // The refusal is the ledger's record, so a replay never silently retries it.
  const validation = f.ledger.entries.find(({ event }) => event.kind === 'validation')?.event;
  assert.ok(validation?.kind === 'validation' && !validation.ok,
    `row: ${name} — the refusal is journaled`);
  assert.equal((await engine.process(forget('forget-4', {
    source: 'src/file-1.ts', ranges: [], label: null,
  }))).status, 'rejected',
  `row: ${name} — the same request is refused again rather than retried`);
  assert.equal(f.port.requests.length, 0,
    `row: ${name} — the retry sends nothing either`);
});
