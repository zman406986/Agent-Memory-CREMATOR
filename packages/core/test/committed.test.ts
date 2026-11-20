import assert from 'node:assert/strict';
import { test } from 'node:test';
import { committedState } from '../src/engine/committed.js';
import { RacoonsEngine } from '../src/engine/engine.js';
import { metadata, readEntries } from '../src/engine/journal.js';
import type { ApplyReceipt } from '../src/ledger/types.js';

import { fixture } from './engine-fixtures.js';

/**
 * A committed ledger row against a fresh host port. Both rows run the same
 * fixture prefix — present, then a prune the host applies — and then differ in
 * one thing only: what the fresh port answers for the receipt. `unknown` means
 * the ledger is the record of record; `not-applied` is a positive contradiction
 * that blocks. One table, because a row that stopped reading the port and a row
 * that stopped reading the ledger are the same defect seen twice.
 */
interface Scene {
  readonly entries: readonly Awaited<ReturnType<typeof readEntries>>[number][];
  readonly applied: ApplyReceipt;
  readonly sealed: readonly string[];
}

const CASES: readonly {
  readonly name: string;
  readonly lookup: 'unknown' | 'not-applied';
  readonly assertState: (name: string, scene: Scene,
    state: Awaited<ReturnType<typeof committedState>>) => void;
}[] = [
  {
    name: 'a ledger applied receipt commits the seal a fresh port cannot confirm',
    lookup: 'unknown',
    assertState: (name, { applied, sealed }, state) => {
      assert.equal(state.blocked, false,
        `row: ${name} — an unknown host answer never blocks a ledger receipt`);
      assert.deepEqual(state.events.get('prune-1'), applied,
        `row: ${name} — the committed receipt is the ledger's own, not the host's`);
      assert.deepEqual(state.sealedEpisodeIds, sealed,
        `row: ${name} — the seal the ledger records is the seal the engine sees`);
      assert.deepEqual(state.conflicts, [],
        `row: ${name} — an unknown answer journals no conflict`);
    },
  },
  {
    name: 'a host refusal of a ledger-applied intent blocks and journals the conflict',
    lookup: 'not-applied',
    assertState: (name, { applied }, state) => {
      assert.equal(state.blocked, true,
        `row: ${name} — a positive host refusal blocks the pass`);
      assert.deepEqual(state.conflicts, [{ intentId: applied.intentId, host: 'not-applied' }],
        `row: ${name} — the contradiction is journaled against the intent it names`);
    },
  },
];

test('committed state looks up each applied intent once', async () => {
  const f = await fixture();
  const engine = await RacoonsEngine.open(f.options);
  await engine.process(f.present);
  assert.equal((await engine.process(f.prune)).status, 'applied');
  const entries = await readEntries(f.ledger, 'session-1');
  const prepared = entries.filter(entry => entry.event.kind === 'prepared');
  assert.equal(prepared.length, 2,
    'the fixture journals both prepared rows for the one intent');
  const appliedIntents = new Set(entries.flatMap(entry => entry.event.kind === 'applied'
    ? [entry.event.receipt.intentId] : []));
  assert.equal(appliedIntents.size, 1);
  let lookups = 0;
  const lookup = f.port.lookupReceipt.bind(f.port);
  f.port.lookupReceipt = async intentId => {
    lookups += 1;
    return lookup(intentId);
  };
  const state = await committedState(entries, f.port);
  assert.equal(state.blocked, false);
  assert.equal(lookups, appliedIntents.size,
    'the duplicate prepared row does not ask the host the same receipt twice');
});

test('committed state — one row per fresh-port answer', async () => {
  for (const row of CASES) {
    const f = await fixture();
    const engine = await RacoonsEngine.open(f.options);
    await engine.process(f.present);
    assert.equal((await engine.process(f.prune)).status, 'applied',
      `row: ${row.name} — the fixture prefix must commit before the port is cleared`);
    const entries = await readEntries(f.ledger, 'session-1');
    const appliedEntry = entries.find(entry => entry.event.kind === 'applied');
    assert.ok(appliedEntry !== undefined, `row: ${row.name} — the prefix journals an applied entry`);
    if (appliedEntry.event.kind !== 'applied') throw new Error(`row: ${row.name} — expected an applied entry`);
    const preparedEntry = entries.find(entry => entry.event.kind === 'prepared');
    assert.ok(preparedEntry !== undefined, `row: ${row.name} — the prefix journals a prepared entry`);
    if (preparedEntry.event.kind !== 'prepared') throw new Error(`row: ${row.name} — expected a prepared entry`);
    const details = metadata(preparedEntry.event);
    assert.ok(details !== null, `row: ${row.name} — the prepared entry carries engine metadata`);
    // A fresh port: the in-process receipt map is empty, so the lookup answers
    // from the engine's chosen status rather than a remembered receipt.
    f.port.receipts.clear();
    f.port.lookup = row.lookup;
    const state = await committedState(entries, f.port);
    row.assertState(row.name, { entries, applied: appliedEntry.event.receipt,
      sealed: details.sealedEpisodeIds }, state);
  }
});
