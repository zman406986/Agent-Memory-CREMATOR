// C5 capability gate (plan §6, §7 C5): all eight flags with their declared values,
// `revertHistory` present and false in the shipped declaration, and the
// defaults-and-frozen case.
//
// The expected object is written out from plan §6, not read back from the module:
// a gate whose expected value comes from the value it checks cannot fail.
//
// Every claim is a row of one table, so a failure names the claim it broke.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CapabilityFlags } from '@cremator/core';
import {
  OPENCODE_CAPABILITIES, createOpencodeCapabilities,
} from '../src/capabilities.js';
import { runRows } from './rows.js';
import type { Row } from './rows.js';

// Plan §6, row by row. `revertHistory` is listed with its value at this stage.
// `mutateResult` is false: the product never caps or rewrites a result body
// (ADR-0048), and `execute.after` is observation only.
const DECLARED: CapabilityFlags = {
  mutateResult: false,
  rewriteHistory: false,
  revertHistory: false,
  atRest: true,
  liveTokens: true,
  log: true,
  appendRecords: false,
  rehydrateOnResume: false,
};

const ROWS: readonly Row[] = [
  { name: 'flags-match-plan-6', run(at) {
    assert.deepEqual(OPENCODE_CAPABILITIES, DECLARED, at('the eight flags match plan §6'));
  } },
  { name: 'no-extra-member', run(at) {
    assert.deepEqual(Object.keys(OPENCODE_CAPABILITIES).sort(), Object.keys(DECLARED).sort(),
      at('a flag the core interface does not name would be unreadable'));
  } },
  { name: 'revert-history-is-checked', run(at) {
    // Non-vacuity: the matcher above distinguishes the one flag that must stay false.
    assert.notDeepEqual({ ...OPENCODE_CAPABILITIES, revertHistory: true }, DECLARED,
      at('a true revertHistory must fail this gate, or the flag is not being checked'));
  } },
  { name: 'defaults-are-declared', run(at) {
    assert.deepEqual(createOpencodeCapabilities(), DECLARED,
      at('nothing supplied yields the declared flags'));
  } },
  { name: 'declaration-is-the-default-call', run(at) {
    assert.deepEqual(OPENCODE_CAPABILITIES, createOpencodeCapabilities(),
      at('the exported declaration is the default call, not a wider variant of it'));
  } },
  { name: 'frozen', run(at) {
    assert.ok(Object.isFrozen(OPENCODE_CAPABILITIES),
      at('a caller must not widen the flags in place'));
  } },
  { name: 'the-recall-path-earns-no-result-mutation', run(at) {
    /**
     * ADR-0057: a restore answer the host cuts is the host's cut, saved under
     * the host's own data home; the product reads its ledger and writes no
     * metadata, pointer or cap of its own. So the recall path adds no
     * capability: both result-mutation flags stay false.
     */
    assert.equal(OPENCODE_CAPABILITIES.mutateResult, false,
      at('the recall tool returns ledger bytes and mutates no other result body'));
    assert.equal(OPENCODE_CAPABILITIES.rewriteHistory, false,
      at('the restore path writes no history'));
  } },
  { name: 'the-bench-ask-declares-at-rest-false', run(at) {
    // The idle path makes one transient model call per fire when the ask is
    // on, so the declaration cannot claim a model-free phase. The shipped
    // declaration above is the ask-off one.
    const asked = createOpencodeCapabilities({ askEnabled: true });
    assert.equal(asked.atRest, false, at('the ask makes the idle path a model-call path'));
    assert.equal(asked.revertHistory, false, at('the ask does not earn the revert seam'));
    assert.equal(OPENCODE_CAPABILITIES.atRest, true,
      at('the exported declaration is unchanged and ask-off'));
  } },
];

test('the declared capability flags — one row per claim', async () => {
  await runRows(ROWS);
});
