// ISSUE-499: a failed mount-state read is named and never silently erased.
//
// Every writer read the doc, merged its own fact and republished the whole
// file. A transient read failure (Windows AV/EBUSY/EPERM on a just-renamed
// file) or corruption read as `{}`, so the next successful write durably
// erased the other facts. Reads were equally silent: a malformed record read as
// an empty list with no cause. The store now names a refused read and fails
// closed (ADR-0065); an absent file still reads as fresh. Offline test.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MOUNT_STATE_FILE, readDurableReceipts, readInstall, readPendingForgets,
  writeDurableReceipt, writeInstall, writePendingForgets,
} from '../src/mount-state.js';
import {
  PRUNE_ROUND_FILE, readPruneRound, readPruneTriggerState, writePendingAppends,
  writePruneRound,
} from '../src/prune-round-store.js';
import { resolveSessionStorage } from '../src/storage.js';
import type { ResolvedRacoonsStorage } from '../src/storage.js';

type Line = { kind: string; [field: string]: unknown };

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-dsh-state-'));
}

const SESSION = 'session-499';
const INSTALL = { generation: 1, installedAtMs: 1, preInstallNodeIds: ['dsh:s:result:c1'],
  sessionId: SESSION };
const FORGET = { eventId: 'forget-1', unitId: 'unit-1', source: 'big.txt', label: null,
  ranges: [{ startLine: 1, endLineInclusive: 2 }] };
const RECEIPT = { intentId: 'intent-1', sessionId: SESSION, baseRevision: 'rev-0',
  resultRevision: 'rev-1', applicationSha256: 'a'.repeat(64), appliedAtMs: 2 };

function targetIn(dir: string): ResolvedRacoonsStorage {
  return resolveSessionStorage(dir, SESSION);
}

function stateFileOf(target: ResolvedRacoonsStorage): string {
  return join(target.databasePath.slice(0, target.databasePath.lastIndexOf('\\')),
    MOUNT_STATE_FILE);
}

function roundFileOf(target: ResolvedRacoonsStorage): string {
  return join(target.databasePath.slice(0, target.databasePath.lastIndexOf('\\')),
    PRUNE_ROUND_FILE);
}

function readOf(path: string): string {
  return readFileSync(path, 'utf8');
}

test('ISSUE-499: a transient read failure refuses the write and keeps sibling facts', async (t) => {
  const root = scratch();
  try {
    const target = targetIn(root);
    const stateFile = stateFileOf(target);
    const journal: Line[] = [];
    assert.equal(writeInstall(target, INSTALL, () => {}, SESSION), true);
    assert.equal(writePendingForgets(target, [FORGET], () => {}, SESSION), true);
    const before = readFileSync(stateFile, 'utf8');
    // The transient failure a Windows AV or a just-renamed file produces: the
    // file is intact, but opening it for read fails.
    const realRead = fs.readFileSync.bind(fs);
    t.mock.method(fs, 'readFileSync', ((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path).endsWith(MOUNT_STATE_FILE)) {
        const error = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      return (realRead as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFileSync);
    const refused = writeDurableReceipt(target, RECEIPT as never,
      (kind, fields) => { journal.push({ kind, ...fields }); }, SESSION);
    t.mock.restoreAll();
    assert.equal(refused, false, 'the write refuses rather than republish a merged empty doc');
    assert.equal(readOf(stateFile), before, 'the install and forget facts are still on disk');
    const refusal = journal.find(line => line.kind === 'mount-state-error'
      && line['refused'] === true);
    assert.ok(refusal !== undefined, 'the refused read is named, not swallowed');
    assert.equal(refusal['fact'], 'receipts', 'the line names the fact it could not write');
    assert.match(String(refusal['reason']), /EBUSY/u, 'the failure carries its cause');
    // The next boundary's write lands and every sibling fact survives it.
    assert.equal(writeDurableReceipt(target, RECEIPT as never, () => {}, SESSION), true);
    const doc = JSON.parse(readFileSync(stateFile, 'utf8')) as
      { install?: unknown; forgets?: unknown[]; receipts?: unknown[] };
    assert.deepEqual(doc.install, INSTALL, 'the install identity survives the later write');
    assert.deepEqual(doc.forgets, [FORGET], 'the owed forget survives the later write');
    assert.equal(doc.receipts?.length, 1, 'the receipt lands beside them');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ISSUE-499: a malformed record read is named, never a silent empty list', () => {
  const root = scratch();
  try {
    const target = targetIn(root);
    const stateFile = stateFileOf(target);
    const journal: Line[] = [];
    mkdirSync(join(root, 'sessions', SESSION), { recursive: true });
    const named = (): Line | undefined => journal.find(line => line.kind === 'mount-state-error');
    // A present document whose forgets record is structurally invalid.
    writeFileSync(stateFile, `${JSON.stringify({ forgets: [{ eventId: 3 }] })}\n`, 'utf8');
    assert.deepEqual(readPendingForgets(target, (kind, fields) => { journal.push({ kind, ...fields }); },
      SESSION), [], 'the fail-open read still answers an empty queue');
    assert.equal(named()?.['fact'], 'forgets', 'the malformed forgets record is named');
    assert.match(String(named()?.['reason']), /structurally invalid/u, 'the defect is named');
    journal.length = 0;
    // A present document whose receipts record is structurally invalid.
    writeFileSync(stateFile, `${JSON.stringify({ receipts: [{ intentId: 'x' }] })}\n`, 'utf8');
    assert.deepEqual(readDurableReceipts(target, (kind, fields) => { journal.push({ kind, ...fields }); },
      SESSION), []);
    assert.equal(named()?.['fact'], 'receipts', 'the malformed receipts record is named');
    journal.length = 0;
    // A document this build cannot parse at all.
    writeFileSync(stateFile, '{not json', 'utf8');
    assert.deepEqual(readDurableReceipts(target, (kind, fields) => { journal.push({ kind, ...fields }); },
      SESSION), [], 'an unreadable document still reads fail-open');
    assert.match(String(named()?.['reason']), /not valid JSON/u, 'the parse failure is named');
    journal.length = 0;
    // A present but malformed install identity is not silently 'fresh'.
    writeFileSync(stateFile, `${JSON.stringify({ install: { generation: 'one' } })}\n`, 'utf8');
    assert.equal(readInstall(target, (kind, fields) => { journal.push({ kind, ...fields }); },
      SESSION), null, 'the fail-open read still answers fresh');
    assert.equal(named()?.['fact'], 'install', 'the malformed install record is named');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ISSUE-499: an absent file is fresh and a good write preserves every fact', () => {
  const root = scratch();
  try {
    const target = targetIn(root);
    const journal: Line[] = [];
    const name = (kind: string, fields: Record<string, unknown>): void => {
      journal.push({ kind, ...fields });
    };
    assert.equal(readInstall(target, name, SESSION), null, 'no file is no install');
    assert.deepEqual(readPendingForgets(target, name, SESSION), [], 'no file is no owed work');
    assert.deepEqual(readDurableReceipts(target, name, SESSION), [], 'no file is no receipt');
    assert.deepEqual(journal, [], 'an absent file is not a failure');
    assert.equal(writeInstall(target, INSTALL, () => {}, SESSION), true);
    assert.equal(writePendingForgets(target, [FORGET], () => {}, SESSION), true);
    assert.equal(writeDurableReceipt(target, RECEIPT as never, () => {}, SESSION), true);
    assert.deepEqual(readInstall(target), INSTALL);
    assert.deepEqual(readPendingForgets(target), [FORGET]);
    assert.equal(readDurableReceipts(target).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ISSUE-499: the round store refuses a republish over a transient read failure', async (t) => {
  const root = scratch();
  try {
    const target = targetIn(root);
    const roundFile = roundFileOf(target);
    const journal: Line[] = [];
    const record = (kind: string, fields: Record<string, unknown>): void => {
      journal.push({ kind, ...fields });
    };
    const latch = { lastFireUsage: 100, belowSinceFire: false, baselinePending: true };
    assert.equal(writePruneRound(target, 4, record, SESSION, latch), true);
    assert.equal(writePendingAppends(target,
      [{ recordId: 'r1', bytesBase64: Buffer.from('owed').toString('base64') }], record, SESSION), true);
    const before = readFileSync(roundFile, 'utf8');
    const realRead = fs.readFileSync.bind(fs);
    const lockRoundFile = (): void => {
      t.mock.method(fs, 'readFileSync', ((path: fs.PathLike, ...rest: unknown[]) => {
        if (String(path).endsWith(PRUNE_ROUND_FILE)) {
          const error = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
          error.code = 'EBUSY';
          throw error;
        }
        return (realRead as (...args: unknown[]) => unknown)(path, ...rest);
      }) as typeof fs.readFileSync);
    };
    lockRoundFile();
    assert.equal(writePruneRound(target, 5, record, SESSION), false,
      'the round write refuses over an unreadable file');
    journal.length = 0;
    assert.equal(readPruneRound(target, record, SESSION), 0,
      'the read still fails open to 0');
    assert.match(String(journal.find(line => line.kind === 'prune-round-error')?.['reason']),
      /EBUSY/u, 'the transient read failure is named');
    t.mock.restoreAll();
    assert.equal(readFileSync(roundFile, 'utf8'), before,
      'the round, the latch and the append intent all survive the refusal');
    // Genuine corruption keeps its documented start-over behavior.
    writeFileSync(roundFile, '{not json', 'utf8');
    assert.equal(writePruneRound(target, 6, () => {}, SESSION), true,
      'an unreadable-for-good file is replaced, not refused');
    assert.equal(readPruneRound(target), 6);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
