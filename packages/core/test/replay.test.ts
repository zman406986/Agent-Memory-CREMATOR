import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RacoonsEngine } from '../src/engine/engine.js';
import { SealRule } from '../src/rules/seal.js';
import type { Rule } from '../src/rules/types.js';
import type { ToolResultNode } from '../src/types/transcript.js';
import type { TelemetryEvent } from '../src/types/telemetry.js';
import { fixture } from './engine-fixtures.js';

const invalid: Rule = { id: 'invalid', plan: context => ({
  ruleId: 'invalid', baseRevision: `${context.snapshot.revision}:stale`,
  removals: [], notes: [], operations: [],
}) };

/**
 * What a reopening engine must make of the bytes and the journal it finds.
 *
 * Each row drives its own `fixture()` because the rows mutate the port
 * differently, but they share one table: a row that stopped reading the ledger
 * and a row that stopped reading the port are the same defect, and a table names
 * which one broke.
 */
const REPLAY_ROWS: readonly (readonly [string, () => Promise<void>])[] = [
  ['append seal leaves warm prefix bytes unchanged and remains sealed after reopen', async () => {
    const name = 'append seal leaves warm prefix bytes unchanged and remains sealed after reopen';
    const f = await fixture();
    const message = f.port.live.nodes[0];
    if (message?.kind !== 'message') throw new Error('Fixture message missing');
    const miss: ToolResultNode = { ...f.first, id: 'result-miss', callId: 'call-miss',
      turnOrdinal: 1, stepOrdinal: 3, evidence: { ...f.first.evidence,
        target: { key: 'missing', label: 'missing' },
        source: { nodeId: 'result-miss', sha256: f.first.sha256, byteLength: f.first.byteLength },
        paths: [{ pathKey: '/a.ts', displayPath: '/a.ts', title: 'A', lineCount: 129,
          byteLength: f.first.byteLength, outcome: 'miss' }] } };
    f.port.live = { ...f.port.live,
      nodes: [{ ...message, toolCallIds: [...message.toolCallIds, 'call-miss'] },
        ...f.port.live.nodes.slice(1), miss],
      currentTurnOrdinal: 2, completedThroughTurnOrdinal: 1,
      cache: { kind: 'warm', watermarkNodeIndex: 2 } };
    const before = structuredClone(f.port.live.nodes);
    const options = { ...f.options, rules: [new SealRule()] };
    const engine = await RacoonsEngine.open(options);
    assert.equal((await engine.process({ kind: 'at-rest', eventId: 'seal-1', reason: 'turn-end' })).status, 'applied',
      `row: ${name} — the seal applies`);
    assert.deepEqual(f.port.live.nodes.slice(0, 2), before.slice(0, 2),
      `row: ${name} — an append seal never rewrites the warm prefix`);
    const application = f.port.requests[0]?.application;
    assert.equal(application?.mode, 'append', `row: ${name} — the host is asked to append, not revert`);
    assert.deepEqual(application?.replacements, [], `row: ${name} — an append ships no replacement`);
    assert.deepEqual(application?.archives, [], `row: ${name} — an append seal archives nothing`);
    const reopened = await RacoonsEngine.open(options);
    assert.equal((await reopened.process({ kind: 'at-rest', eventId: 'seal-2', reason: 'step' })).status, 'unchanged',
      `row: ${name} — a reopened engine sees the episode already sealed`);
    assert.equal(f.port.requests.length, 1, `row: ${name} — the reopen sends no second application`);
  }],
  ['prepared-only seal never becomes committed seal state', async () => {
    const name = 'prepared-only seal never becomes committed seal state';
    const f = await fixture();
    let observed: readonly string[] | undefined;
    const planned: Rule = { id: 'inspect-seals', plan: context => {
      observed = context.sealedEpisodeIds;
      return null;
    } };
    const engine = await RacoonsEngine.open({ ...f.options, rules: [planned] });
    await f.ledger.append({ kind: 'prepared', eventKey: 'orphan', atMs: 1,
      sessionId: f.options.sessionId, intentId: 'orphan', applicationSha256: 'f'.repeat(64) });
    // An orphan prepare is an unknown outcome: blocked, never auto-abandoned (R3).
    assert.equal((await engine.process(f.present)).status, 'recovery-pending',
      `row: ${name} — an orphan prepare blocks the pass for recovery`);
    assert.equal(f.port.requests.length, 0, `row: ${name} — a blocked pass sends no application`);
    assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'abandoned').length, 0,
      `row: ${name} — an unknown outcome is never auto-abandoned`);
    assert.equal(observed, undefined,
      `row: ${name} — no plan ran, so the sealed set was never read into a rule`);
  }],
  ['a persisted disable is announced in the same turn and never latches the session', async () => {
    const name = 'a persisted disable is announced in the same turn and never latches the session';
    const f = await fixture();
    // The last validation said disabled, at the very turn the snapshot is on:
    // the single-turn record a bench arm produces (ISSUE-057 defect 3).
    await f.ledger.append({ kind: 'validation', eventId: 'last-failure',
      eventKey: 'last-failure', sessionId: f.options.sessionId, atMs: 50, ok: false,
      issues: [], breaker: { consecutiveValidationFailures: 2, disabled: true } });
    const engine = await RacoonsEngine.open(f.options);
    const outcome = await engine.process(f.present);
    // The pass runs: a disable is history to be announced, not a stop switch
    // (ISSUE-057 defect 2).
    assert.notEqual(outcome.status, 'disabled',
      `row: ${name} — a persisted disable does not close the pass`);
    assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'breaker-disabled').length, 1,
      `row: ${name} — the disable is journaled exactly once`);
    // The notice is one appended record, at the same turn ordinal, with no
    // `currentTurnOrdinal >` gate to satisfy.
    const notices = f.port.live.nodes.filter(node => node.kind === 'racoons-record'
      && node.recordId === 'racoons:breaker-disabled:session-1');
    assert.equal(notices.length, 1, `row: ${name} — the disable is delivered inside one turn`);
    assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'breaker-announced').length, 1,
      `row: ${name} — the announcement is recorded`);
    assert.equal(f.port.requests.length, 1, `row: ${name} — the notice is the only host application`);
    // The next boundary is live again: a fresh engine plans instead of closing.
    // A prune event is the live per-unit lane left (ADR-0028), so it is the one
    // whose answer must reach the guard after the disable was announced.
    const events: TelemetryEvent[] = [];
    const next = await RacoonsEngine.open({ ...f.options, onTelemetry: event => events.push(event) });
    await next.process({ ...f.prune, eventId: 'next-boundary' });
    assert.ok(events.some(event => event.kind === 'validation'),
      `row: ${name} — a disabled breaker no longer silences the whole run`);
  }],
];

test('replay — one row per reopening rule', async () => {
  for (const [name, run] of REPLAY_ROWS) {
    try { await run(); } catch (error) {
      if (error instanceof Error && error.message.startsWith(`row: ${name}`)) throw error;
      throw new Error(`row: ${name} — ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
});

/**
 * What one pass measures and what it does to the failure streak. Both rows walk
 * the same present-then-boundary prefix, so they belong in one table: a pass that
 * stopped resetting the streak and a pass that stopped reporting its own bytes
 * are both "the accounting behind the pass changed".
 */
const PASS_ROWS: readonly (readonly [string, () => Promise<void>])[] = [
  ['no-op does not reset failures; a valid nonempty application does', async () => {
    const name = 'no-op does not reset failures; a valid nonempty application does';
    const f = await fixture();
    await (await RacoonsEngine.open({ ...f.options, rules: [invalid] })).process({ ...f.present, eventId: 'bad-1' });
    await (await RacoonsEngine.open({ ...f.options, rules: [] })).process({ ...f.present, eventId: 'no-op' });
    const outcome = await (await RacoonsEngine.open({ ...f.options, rules: [invalid] }))
      .process({ ...f.present, eventId: 'bad-2' });
    assert.equal(outcome.status, 'disabled',
      `row: ${name} — a no-plan pass is still a completed validation, so the streak survives it`);
    const second = await fixture();
    await (await RacoonsEngine.open({ ...second.options, rules: [invalid] }))
      .process({ ...second.present, eventId: 'bad-1' });
    const valid = await RacoonsEngine.open(second.options);
    await valid.process(second.present);
    assert.equal((await valid.process(second.prune)).status, 'applied',
      `row: ${name} — a valid nonempty application applies`);
    assert.equal((await (await RacoonsEngine.open({ ...second.options, rules: [invalid] }))
      .process({ kind: 'at-rest', eventId: 'bad-2', reason: 'step' })).status, 'rejected',
      `row: ${name} — that pass reset the streak, so the next refusal is rejected, not disabled`);
  }],
  ['exact-content refetch is measured by source hash without text search', async () => {
    const name = 'exact-content refetch is measured by source hash without text search';
    const f = await fixture();
    const events: TelemetryEvent[] = [];
    const engine = await RacoonsEngine.open({ ...f.options, onTelemetry: event => events.push(event) });
    await engine.process(f.present);
    await engine.process(f.prune);
    await engine.process(f.entry);
    const refetch = events.find(event => event.kind === 'refetch');
    assert.ok(refetch?.kind === 'refetch', `row: ${name} — the re-entry emits a refetch event`);
    assert.equal(refetch.fetchedBytes, f.first.bytes.length,
      `row: ${name} — the refetch is measured in the fetched body's bytes`);
    assert.equal(refetch.sourceSha256, f.first.sha256,
      `row: ${name} — the refetch is identified by its source hash, never by a text search`);
  }],
];

test('pass accounting — one row per measured pass', async () => {
  for (const [name, run] of PASS_ROWS) {
    try { await run(); } catch (error) {
      if (error instanceof Error && error.message.startsWith(`row: ${name}`)) throw error;
      throw new Error(`row: ${name} — ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
});
