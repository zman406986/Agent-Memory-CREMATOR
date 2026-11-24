import type { CapabilityFlags } from '@cremator/core';

/**
 * One L1 family this host's transcript projection cannot prove, with the fact
 * it needs and the host shape that withholds it.
 */
export interface OpencodeInactiveL1Rule {
  readonly rule: 'closed-episode' | 'superseded-by-reread';
  /** The `PathEvidence` fact the family needs. */
  readonly requires: string;
  /** The host shape that makes the fact unavailable. */
  readonly blockedBy: string;
}

/**
 * One L1 fact the adapter derives from the host's own shape, with the sources
 * it reads. `closed-episode` and `superseded-by-reread` are active rules; this
 * declaration states how their facts are proved, not that they are withheld.
 */
export interface OpencodeL1Fact {
  readonly rule: 'closed-episode' | 'superseded-by-reread';
  /** How the snapshot derives the `PathEvidence` fact the rule reads. */
  readonly derives: string;
}

/**
 * The two L1 facts the snapshot derives from host data (ISSUE-300 F3a/F3b;
 * ADR-0054 §Amendment 2026-11-19, second).
 *
 * `closed-episode` reads `PathEvidence.outcome: 'miss'`. The snapshot states it
 * when the read result is the host's structured error value
 * (`OpencodeToolResultValue.type === 'error'`, or the cancelled `question`
 * envelope `opencodeIsErrorResult` names). `superseded-by-reread` reads
 * `PathEvidence.coverage: 'full'` on the later read; the snapshot states
 * `'full'` for an untruncated, unranged whole read and `'partial'` when the
 * call names the read tool's `offset`/`limit` range.
 */
export const OPENCODE_L1_FACTS: readonly OpencodeL1Fact[] = Object.freeze([
  Object.freeze({
    rule: 'closed-episode',
    derives: 'PathEvidence.outcome = "miss" from the host\'s structured error result '
      + '(OpencodeToolResultValue.type === "error", or the cancelled question envelope)',
  }),
  Object.freeze({
    rule: 'superseded-by-reread',
    derives: 'PathEvidence.coverage = "full" on an untruncated, unranged whole read '
      + '("partial" when the read names offset/limit)',
  }),
]);

/**
 * The derivable-fact residuals this host still has. Neither blocks an L1 rule;
 * each narrows when its fact can be proved. A text-only error body without the
 * structured tag is a hit by design (the derivation reads the tag, never a text
 * search), and the truncation notice is matched in the host's English wording.
 */
export const OPENCODE_L1_FACT_RESIDUALS: readonly string[] = Object.freeze([
  'a text-only error body without the host\'s structured error tag is not treated as an error',
  'truncation detection depends on the host\'s English notice',
]);

/**
 * No L1 family is inactive on this host (ISSUE-300 F3b). The two facts the
 * earlier declaration called withheld are now derived — see
 * `OPENCODE_L1_FACTS` — so the list is empty. The residuals above are limits on
 * the derivation, not rules that cannot fire. `stale-exact-reread` and
 * `byte-identical-duplicates` need only the bytes and the call's declared
 * target and were always active.
 */
export const OPENCODE_INACTIVE_L1_RULES: readonly OpencodeInactiveL1Rule[] = Object.freeze([]);

/**
 * The flags this adapter honours today, each stated with the path that backs it
 * or refuses it (ISSUE-010; plan §6). A flag is true only when a code path
 * honours it, and false only when the refusal is named.
 */
const DECLARED = {
  // `execute.after` observes the tool and call id only; the product never caps,
  // shortens or rewrites a result body (ADR-0048), so the host's own
  // `ToolOutput.truncate` runs as it ships. That includes the `necromancy`
  // restore answer: when the host cuts it, the host saves the full text under
  // its own data home and points there. The product reads its session ledger,
  // never that cache (ADR-0057), and writes no `metadata` or pointer of its own.
  mutateResult: false,
  // Nothing persisted is rewritten: a context hook mutation is visible to one
  // request, not to the host's stored history.
  rewriteHistory: false,
  // The shipped path makes no model call in the `context` hook or at
  // `session.idle`. The bench-only ask changes that: with `askEnabled: true`
  // the context hook (and the idle fallback) makes ONE transient
  // `session.generate` request per fire, so `atRest` is declared false for that
  // build (see `createOpencodeCapabilities`). The engine still receives
  // `atRest: true` because the at-rest pass itself stays model-free and is the
  // only applied-removal path.
  atRest: true,
  // `session.step.ended` carries the step's usage, cache read and write included.
  liveTokens: true,
  // One ledger per session, kept under the adapter's own storage root.
  log: true,
  // A `session.synthetic` append is durable and reaches the model as a user
  // message, but each emission costs exactly one extra main model request:
  // 1 prompt alone is 1, and prompt plus the append is 2 under resume:false,
  // delivery "queue" and resume:true alike (ADR-0049). A sealed negative fact
  // would spend a model turn and remove no bytes. The ledger's revert plan
  // names every receipt the array renders, so a receipt is not an append
  // record.
  appendRecords: false,
  // The applied-plan index is seeded from the ledger at open, so a restart
  // re-applies the banked removals instead of treating them as new (ISSUE-409).
  // The last assembled request is saved beside the ledger for the manual pass
  // (ADR-0076); the host conversation itself is still rebuilt by the host.
  rehydrateOnResume: false,
} as const;

/**
 * Capability flags for this adapter build (plan §6).
 *
 * `revertHistory` is earned, never assumed (ADR-0017; ISSUE-010). It stays
 * `false` unless the caller passes `wireRevert: true`, which only a build that
 * wires `src/apply.ts` through the transform may do — and the port refuses that
 * flag without the derivation, so the flag and the code path behind it are one
 * claim (C4's constructor pair). `test/wire-revert.test.ts` is the wire-level
 * proof: prefix byte-identical, named tail gone, receipts present once after
 * their anchor, second run idempotent, every refusal leaves the array untouched.
 *
 * `askEnabled: true` is the bench-only ask. It is the one build whose request
 * path makes a transient model call, so `atRest` is false there; the shipped
 * mount passes nothing and keeps `atRest: true`.
 *
 * `OPENCODE_CAPABILITIES` is the `revertHistory: false` declaration, and stays
 * that: a module-level constant cannot be earned per mount, so the mount passes
 * its own argument and journals what it declared.
 */
export function createOpencodeCapabilities(
  options: {
    readonly wireRevert?: boolean;
    /**
     * The bench-only ask. When true, the `context` hook (and the idle
     * fallback) calls `session.generate` once per fire, so this build declares
     * `atRest: false`: the seam is no longer a model-free phase. The shipped
     * mount passes nothing, and `OPENCODE_CAPABILITIES` stays the ask-off
     * declaration.
     */
    readonly askEnabled?: boolean;
  } = {},
): CapabilityFlags {
  return Object.freeze({
    ...DECLARED,
    revertHistory: options.wireRevert === true,
    atRest: options.askEnabled !== true,
  });
}

/**
 * The declaration the shipped port carries: `createOpencodeCapabilities()` with
 * nothing supplied. Frozen, so a caller cannot widen it in place.
 */
export const OPENCODE_CAPABILITIES: CapabilityFlags = createOpencodeCapabilities();
