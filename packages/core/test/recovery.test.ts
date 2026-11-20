import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverPending } from '../src/engine/recovery.js';
import { RacoonsEngine } from '../src/engine/engine.js';
import type { ApplyReceipt, LedgerEvent } from '../src/ledger/types.js';
import { fixture, TestPort } from './engine-fixtures.js';

const prepared: LedgerEvent = {
  kind: 'prepared', sessionId: 'session-1', eventKey: 'prepared:intent-1', atMs: 10,
  intentId: 'intent-1', applicationSha256: 'a'.repeat(64),
};
const receipt: ApplyReceipt = {
  sessionId: 'session-1', intentId: 'intent-1', baseRevision: 'revision-1',
  resultRevision: 'revision-2', applicationSha256: 'a'.repeat(64), appliedAtMs: 20,
};

/**
 * One prepared intent and one host answer. Every row starts from the same
 * ledger, so the only variable is what the host says: the outcome, the receipt,
 * whether the receipt write fails, and whether the lookup throws.
 */
interface RecoveryRow {
  readonly name: string;
  /** What the host answers when asked about the intent. */
  readonly lookup?: 'not-applied' | 'unknown';
  /** A receipt the host holds, which recovery verifies and may append. */
  readonly receipt?: ApplyReceipt;
  /** The receipt lookup itself throws: no outcome can be proven. */
  readonly lookupThrows?: boolean;
  /** The ledger refuses the applied write. */
  readonly failApplied?: boolean;
  readonly expected: {
    readonly status: 'clear' | 'reconciled' | 'blocked';
    readonly intentIds: readonly string[];
    readonly conflicts: readonly { readonly intentId: string; readonly host: string }[];
  };
  /** Kinds recovery may have appended, in ledger order. */
  readonly appended: readonly string[];
  /** Entries the ledger holds afterwards; 1 is the prepared event alone. */
  readonly entries: number;
  readonly requests: number;
  /** A reconciled row is settled: a second pass must answer exactly this. */
  readonly settled: boolean;
}

const RECONCILED = { status: 'reconciled', intentIds: ['intent-1'], conflicts: [] } as const;
const BLOCKED = { status: 'blocked', intentIds: ['intent-1'], conflicts: [] } as const;

const RECOVERY_ROWS: readonly RecoveryRow[] = [
  { name: 'a confirmed non-application appends abandonment once', lookup: 'not-applied',
    expected: RECONCILED, appended: ['abandoned'], entries: 2, requests: 0, settled: true },
  { name: 'a host receipt the ledger lacks is verified and appended once', receipt,
    expected: RECONCILED, appended: ['applied'], entries: 2, requests: 0, settled: true },
  { name: 'a receipt naming other bytes cannot commit the prepared state',
    receipt: { ...receipt, applicationSha256: 'b'.repeat(64) },
    expected: BLOCKED, appended: [], entries: 1, requests: 0, settled: false },
  { name: 'a lookup that throws proves nothing and stays blocked', lookupThrows: true,
    expected: BLOCKED, appended: [], entries: 1, requests: 0, settled: false },
  { name: 'a receipt the ledger refuses to record stays blocked',
    receipt, failApplied: true,
    expected: BLOCKED, appended: [], entries: 1, requests: 0, settled: false },
  { name: 'an unknown outcome blocks and appends nothing', lookup: 'unknown',
    expected: BLOCKED, appended: [], entries: 1, requests: 0, settled: false },
];

/** Arms the fake host and ledger for one row. */
function arm(f: Awaited<ReturnType<typeof fixture>>, row: RecoveryRow): void {
  if (row.lookup !== undefined) f.port.lookup = row.lookup;
  if (row.receipt !== undefined) f.port.receipts.set('intent-1', row.receipt);
  if (row.lookupThrows === true) {
    f.port.lookupReceipt = async () => { throw new Error('Host unavailable'); };
  }
  if (row.failApplied === true) f.ledger.failApplied = true;
}

test('reconciliation — one row per host answer', async () => {
  for (const row of RECOVERY_ROWS) {
    const f = await fixture();
    await f.ledger.append(prepared);
    arm(f, row);

    assert.deepEqual(await recoverPending(f.ledger, f.port, 'session-1'), row.expected,
      `row: ${row.name} — the outcome`);
    assert.deepEqual(f.ledger.entries.slice(1).map(({ event }) => event.kind), row.appended,
      `row: ${row.name} — what was appended`);
    assert.equal(f.ledger.entries.length, row.entries,
      `row: ${row.name} — the ledger's entry count`);
    assert.equal(f.port.requests.length, row.requests,
      `row: ${row.name} — recovery applies nothing of its own`);
    assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'abandoned').length,
      row.lookup === 'not-applied' ? 1 : 0,
      `row: ${row.name} — only a confirmed non-application writes an abandonment`);

    // A reconciled intent is settled: the record is durable, so a second pass
    // answers clear and appends nothing again.
    if (row.settled) {
      const before = f.ledger.entries.length;
      assert.deepEqual(await recoverPending(f.ledger, f.port, 'session-1'),
        { status: 'clear', intentIds: [], conflicts: [] },
        `row: ${row.name} — the second reconciliation`);
      assert.equal(f.ledger.entries.length, before,
        `row: ${row.name} — the settled intent appends nothing again`);
    }
  }
});

/**
 * A crash, at take one of two points: the prepare write itself, after which no
 * intent is known, or the receipt write after a real host apply, after which a
 * fresh process cannot prove what happened. Neither may be written off.
 */
interface CrashRow {
  readonly name: string;
  readonly crash: 'prepare' | 'receipt';
  /** Host applies a crashed prepare reaches; a lost prepare reaches none. */
  readonly applies: number;
}

const CRASH_ROWS: readonly CrashRow[] = [
  { name: 'a prepare that throws leaves the pass skipped, before and after a reopen',
    crash: 'prepare', applies: 0 },
  { name: 'a lost receipt after a real apply stays blocked from a fresh process',
    crash: 'receipt', applies: 1 },
];

test('engine passes — a crash is never converted into an abandonment', async () => {
  for (const row of CRASH_ROWS) {
    const f = await fixture();
    const append = f.ledger.append.bind(f.ledger);
    if (row.crash === 'prepare') {
      f.ledger.append = async event => {
        if (event.eventKey.startsWith('engine-prepared:')) throw new Error('Crash after prepare');
        return append(event);
      };
    } else {
      f.ledger.failApplied = true;
    }

    const engine = await RacoonsEngine.open(f.options);
    await engine.process(f.present);
    assert.equal((await engine.process(f.prune)).status, 'recovery-pending',
      `row: ${row.name} — the pass is skipped while the outcome is unproven`);
    assert.equal(f.port.requests.length, row.applies,
      `row: ${row.name} — only a reached prepare applies, and once`);

    // The restart: a reopened engine (or, for a lost receipt, a fresh process
    // with no receipts in memory) must reach the same conclusion.
    if (row.crash === 'prepare') {
      f.ledger.append = append;
      const reopened = await RacoonsEngine.open(f.options);
      await reopened.process(f.present);
      assert.equal((await reopened.process(f.prune)).status, 'recovery-pending',
        `row: ${row.name} — a reopened engine reaches the same conclusion`);
      assert.equal(f.port.requests.length, 0, `row: ${row.name} — still no host write`);
    } else {
      const intentId = f.port.requests[0]?.intent.intentId;
      assert.ok(intentId !== undefined, `row: ${row.name} — the applied request names its intent`);
      const fresh = new TestPort(f.port.live, f.first);
      fresh.lookup = 'unknown';
      assert.deepEqual(await recoverPending(f.ledger, fresh, 'session-1'),
        { status: 'blocked', intentIds: [intentId], conflicts: [] },
        `row: ${row.name} — a fresh process cannot prove the outcome, so it blocks`);
      assert.equal(fresh.requests.length, 0, `row: ${row.name} — the blocking process applies nothing`);
    }
    assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'abandoned').length, 0,
      `row: ${row.name} — an unproven outcome is never written off as abandoned`);
  }
});
