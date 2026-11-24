/**
 * The two journal gates that replaced the cap-count gate (ISSUE-089).
 *
 * ADR-0014 (2026-10-23) scrapped cap materialization: the core renderer refuses
 * a `cap` operation (`packages/core/src/guard/candidate.ts`: "The entry-time cap
 * has no materialization arm"), so `capArchives` is 0 on every artifact. The old
 * gate compared that 0 + the host pruner's count against every `replace` surface
 * op in the session log, which is three other lanes: the keep-all exchange
 * rewind (`user/message`), the answered-entry forget and the prune
 * checkpoint-revert (`tool/result`). It would have failed a real run on 0 vs N.
 *
 * Two gates stand in its place:
 *
 *   1. `fidelity: no cap archives exist (ADR-0014)` — an invariant, red on any
 *      `publish` archive whose `operationKind` is `cap`. A journal that
 *      published no archive at all is `not-applicable`: there was no subject
 *      (fourteenth audit item 5).
 *   2. `fidelity: the <arm> arm's tool/result replacements match the applied
 *      removals` — a like-for-like count between the host's session log and the
 *      mount's journal:
 *
 *        tool/result `replace` ops
 *          == applied prune removals (`prune-apply status=applied` `removals`)
 *           + applied at-rest proof removals (`at-rest status=applied`, counted
 *                                  as the `recallIds` length on the matching
 *                                  `application` telemetry)
 *           + landed entry shapes  (`entry-apply status=landed`)
 *           + applied manual forgets (`forget status=applied`)
 *           + host pruner trims    (`compaction/prune`, when the composed config
 *                                  leaves the host pruner mounted)
 *
 * Why the lanes are the whole list: every removal this product plans addresses a
 * processing unit, and a unit is minted only from a tool-result node
 * (`packages/core/src/units/tracker.ts`), so every removal rewrites a
 * `tool/result`. Each applied revert is ONE host append (`revert.ts`
 * `applyValidatedRevert`), and dsh refuses a multi-node tool/result span
 * (`revert.ts`: `multi-node-tool-result`), so an applied pass/forget is exactly
 * one `tool/result` replace. A landed entry shape is one content-only
 * `tool/result` replace (`plugin.ts` `publishEntry`).
 *
 * An at-rest proof pass is the exception to "the prune lane states its count":
 * it applies through the at-rest window and writes no `prune-apply` line. Its
 * removals are stated only on the application telemetry, as one `recallId` per
 * removed unit. The lane is therefore the `recallIds` length for intents the
 * journal recorded as `at-rest status=applied` — never one per applied pass,
 * which would read 1 where the host spliced 2. Application telemetry for a
 * prune intent is already counted by the `prune-apply` lane, so the intent set
 * is what keeps the two lanes from double counting.
 *
 * Why the rewinds are NOT in the equality: a keep-all writes one `user/message`
 * replace with empty content over the ask exchange (`port.ts`
 * `writeEmptyRange`). That is a host splice of turns, not a removal — nothing
 * was forgotten, no archive exists, and the journal's only trace is
 * `entry-apply status=rewound`. Counting it here would make every keep-all run
 * red against a zero removal count; `2026-10-27-keepall-final` is exactly that
 * shape (1 `user/message` replace, 0 removals, 0 `tool/result` replaces). The
 * count is still reported so a reader can see the lane exists.
 *
 * The expected side of every gate is a file written by a different code path:
 * the session log by the host, the journal by the mount. Counts are evidence,
 * never a target.
 */

/** The invariant's gate name. `--perturb-journal-caps` must turn this red. */
export const CAP_ARCHIVE_GATE = 'fidelity: no cap archives exist (ADR-0014)';

/** The accounting gate's name, arm-qualified like every other journal gate. */
export function replacementGateName(arm) {
  return `fidelity: the ${String(arm)} arm's tool/result replacements match the applied removals`;
}

/**
 * The zero-caps invariant. `capArchives` is invariant at 0 (ADR-0014), so any
 * other value — including the negative the perturbation can produce — is red.
 *
 * Fourteenth audit item 5: with no archive at all the row states `not-applicable`
 * — the invariant could not have failed, and counting that as a measured pass
 * inflates the pass count. `archiveTotal` is every `publish.archives[]` entry
 * (cap, evict, verdict and anything unnamed), so "no archives" means the journal
 * published nothing, not just no caps.
 * @param {{capArchives?: number, evictArchives?: number, verdictArchives?: number,
 *   archiveTotal?: number}} journal - the derived journal counts.
 * @returns {{ok: boolean, class: string, detail?: string}}
 */
export function capArchiveGate(journal) {
  const count = Number(journal?.capArchives ?? 0);
  if (count !== 0) {
    return { ok: false, class: 'failed',
      detail: `${String(count)} cap archive(s) on a publish line; ADR-0014 scrapped cap `
        + 'materialization, so no publish may carry operationKind cap' };
  }
  const archiveTotal = Number(journal?.archiveTotal
    ?? Number(journal?.capArchives ?? 0)
      + Number(journal?.evictArchives ?? 0)
      + Number(journal?.verdictArchives ?? 0));
  if (archiveTotal === 0) {
    return { ok: true, class: 'not-applicable',
      detail: 'no archive was published, so the zero-caps invariant was not exercised' };
  }
  return { ok: true, class: 'measured',
    detail: `${String(archiveTotal)} published archive(s), none with operationKind cap` };
}

/**
 * The applied-removal lanes, read from the journal lines the mount writes.
 * Pure so the test can pin the shapes; `bench-run.mjs` runs it over the parsed
 * journal, and the counts it returns are what `result.json` records.
 *
 * Two passes because the at-rest proof lane's two lines are not ordered: the
 * `application` telemetry may precede the `at-rest status=applied` line it
 * belongs to (2026-11-08 rerun). The first pass collects the applied at-rest
 * intents; the second counts their telemetry `recallIds` and the prune, entry
 * and forget lanes.
 * @param {object[]} lines - parsed journal records, in order.
 * @returns {{appliedRemovals: number, landedEntries: number,
 *   appliedForgets: number, rewinds: number}}
 */
export function journalLanes(lines) {
  const records = Array.isArray(lines) ? lines : [];
  // The proof lane's intents. A pass that applied through the at-rest window
  // writes no `prune-apply` line, so this set is the only place its removals
  // are named; the count comes from the telemetry's `recallIds`, not the pass.
  const atRestAppliedIntents = new Set();
  for (const line of records) {
    if (line?.kind === 'at-rest' && line.status === 'applied'
      && typeof line.intentId === 'string' && line.intentId.length > 0) {
      atRestAppliedIntents.add(line.intentId);
    }
  }
  let appliedRemovals = 0;
  let landedEntries = 0;
  let appliedForgets = 0;
  let rewinds = 0;
  for (const line of records) {
    if (line?.kind === 'prune-apply' && line.status === 'applied') {
      // A refused or abandoned pass wrote nothing to the surface; only an
      // applied one holds removals the host actually spliced out.
      const removals = Number(line.removals ?? 0);
      if (Number.isFinite(removals) && removals > 0) appliedRemovals += removals;
      continue;
    }
    if (line?.kind === 'telemetry' && line.event?.kind === 'application'
      && line.event.outcome === 'applied' && atRestAppliedIntents.has(line.event.intentId)) {
      // One recall id per removed unit. A pass with no ids removed nothing
      // this lane can see, so it adds 0 rather than 1.
      const recallIds = Array.isArray(line.event.recallIds) ? line.event.recallIds : [];
      appliedRemovals += recallIds.length;
      continue;
    }
    if (line?.kind === 'entry-apply') {
      if (line.status === 'landed') landedEntries += 1;
      else if (line.status === 'rewound') rewinds += 1;
      continue;
    }
    if (line?.kind === 'forget' && line.status === 'applied') appliedForgets += 1;
  }
  return { appliedRemovals, landedEntries, appliedForgets, rewinds };
}

/**
 * The host pruner's trim count: one `compaction/prune` trim is one `tool/result`
 * replace exactly when the pruner is mounted. The composed config decides that —
 * `isolation` is the `dump-config-host-pruner.yml` read-back, and the pruner is
 * mounted when at least one composed copy of its row is enabled. When the dump
 * read no row, the pruner was mounted if no dump was taken, or if the run opted
 * out (`allowHostPruner`; `endPressureIsolation` is the older spelling of the
 * same choice). Since ADR-0041 a dump is taken on every run, so the no-dump
 * branch is reached only by a caller that passes no read-back.
 * @param {{pruneEvents?: number,
 *   isolation?: {rows?: number, disabledRows?: number}|null,
 *   endPressureIsolation?: boolean, allowHostPruner?: boolean}} input
 * @returns {number}
 */
export function hostPrunerTrims({ pruneEvents, isolation, endPressureIsolation, allowHostPruner }) {
  const rows = Number(isolation?.rows ?? 0);
  const optedOut = endPressureIsolation === true || allowHostPruner === true;
  const mounted = rows > 0
    ? Number(isolation.disabledRows ?? 0) < rows
    : isolation === null || isolation === undefined || optedOut;
  return mounted ? Number(pruneEvents ?? 0) : 0;
}

/**
 * The like-for-like accounting: the host's `tool/result` replacements against
 * the removals the mount says it applied.
 *
 * `hostPruned` is the `compaction/prune` count the session log states, passed
 * exactly when the host pruner is mounted — `hostPrunerTrims` reads that from
 * the composed config. A run whose config disabled the pruner logs no trims, so
 * its lane is 0.
 *
 * Fourteenth audit item 5: 0 == 0 is an empty subject — no replacement was
 * stored and no lane accounts for one — so the row is `not-applicable`, never a
 * measured equality. With any replacement on either side the comparison can
 * fail and keeps its class.
 *
 * @param {{arm: string, hostPruned: number, sessionEvents: object[], journal: object|null}} input
 *   - `journal` is the journal's derived counts (`journalLanes` fields), or null
 *     when the mount wrote no journal.
 * @returns {{ok: boolean, class: string, detail?: string, replaced: number, applied: number}}
 */
export function replacementAccounting({ arm, hostPruned, sessionEvents, journal }) {
  const replaced = (Array.isArray(sessionEvents) ? sessionEvents : [])
    .filter((event) => event?.type === 'tool/result'
      && typeof event.surfaceOp === 'object' && event.surfaceOp !== null
      && event.surfaceOp.op === 'replace').length;
  const pruned = Number(hostPruned ?? 0);
  if (arm !== 'racoons') {
    // The vanilla arm stores no replacement of its own: every one is the host
    // pruner's, and the log states how many it made.
    if (replaced !== pruned) {
      return { ok: false, class: 'failed', replaced, applied: pruned,
        detail: `the vanilla arm stored ${String(replaced)} tool/result replacement(s); `
          + `the host pruner logged ${String(pruned)}` };
    }
    return replaced === 0
      ? { ok: true, class: 'not-applicable', replaced, applied: pruned,
        detail: 'no tool/result replacement was stored and the host pruner logged no trim; '
          + 'the replacement lane was not exercised' }
      : { ok: true, class: 'measured', replaced, applied: pruned,
        detail: `${String(replaced)} tool/result replacement(s) are the host pruner's ${String(pruned)} trim(s)` };
  }
  if (journal === null || journal === undefined) {
    return { ok: false, class: 'failed', replaced, applied: 0,
      detail: 'no journal to compare against the stored surface' };
  }
  const applied = Number(journal.appliedRemovals ?? 0)
    + Number(journal.landedEntries ?? 0)
    + Number(journal.appliedForgets ?? 0)
    + pruned;
  if (replaced === applied) {
    return replaced === 0
      ? { ok: true, class: 'not-applicable', replaced, applied,
        detail: 'no tool/result replacement was stored and no lane accounts for one; '
          + 'the replacement lane was not exercised' }
      : { ok: true, class: 'measured', replaced, applied,
        detail: `${String(replaced)} tool/result replacement(s) match the applied lanes` };
  }
  return { ok: false, class: 'failed', replaced, applied,
    detail: `the session log stores ${String(replaced)} tool/result replacement(s); the journal `
      + `accounts for ${String(applied)}: ${String(journal.appliedRemovals ?? 0)} applied removal(s), `
      + `${String(journal.landedEntries ?? 0)} landed entry shape(s), `
      + `${String(journal.appliedForgets ?? 0)} applied forget(s), `
      + `${String(pruned)} host pruner trim(s). `
      + `${String(journal.rewinds ?? 0)} keep-all rewind(s) are a different lane and are not counted` };
}

/**
 * The run-level removal statement: the journal's applied-removal lanes, in the
 * shape `result.json.removals` carries and the PASS line prints (fifteenth
 * audit item 2).
 *
 * Before this existed a live run with ZERO applied removals was `passed: true`
 * and `citableAs: "measurement (product effect only)"` — indistinguishable from
 * a run whose product effect was actually measured. `exercised` and `reason`
 * make the empty case a stated fact: the run measured the host and the mount's
 * presence, not a removal.
 *
 * `applied` is journal-derived only (the audit's item 6 compares it to the
 * ledger separately). It is the count the product's own journal says the host
 * spliced out: applied prune removals + applied at-rest proof removals + landed
 * entry shapes + applied manual forgets. The host pruner's trims are NOT
 * counted — they are the host's mechanism, never the product's.
 * @param {{arm: string, journal: object|null}} input - `journal` is the derived
 *   count object (`journalLanes` fields), or null when no journal was written.
 * @returns {{applied: number, exercised: boolean, reason: string}}
 */
export function removalSummary({ arm, journal }) {
  if (arm !== 'racoons') {
    return { applied: 0, exercised: false,
      reason: 'the vanilla arm loads no mount, so no product removal can be applied' };
  }
  if (journal === null || journal === undefined) {
    return { applied: 0, exercised: false,
      reason: 'the mount wrote no journal, so no applied removal was recorded' };
  }
  const appliedRemovals = Number(journal.appliedRemovals ?? 0);
  const landedEntries = Number(journal.landedEntries ?? 0);
  const appliedForgets = Number(journal.appliedForgets ?? 0);
  const applied = appliedRemovals + landedEntries + appliedForgets;
  if (applied === 0) {
    return { applied, exercised: false,
      reason: 'the journal records no applied prune removal, landed entry shape or applied forget; '
        + 'the run measured the host and the mount\'s presence, not a product removal' };
  }
  return { applied, exercised: true,
    reason: `${String(applied)} applied removal(s): ${String(appliedRemovals)} removal(s) from the `
      + `applied prune/proof lanes, `
      + `${String(landedEntries)} landed entry shape(s), ${String(appliedForgets)} applied forget(s)` };
}

/**
 * The `citableAs` label with the removal qualifier (fifteenth audit item 2).
 * Only a `measurement (…)` label can be qualified: a `none (…)` label already
 * states the run is not citable, and appending to it would blur the reason.
 * @param {string} label - `result.json.reasoning.citableAs`.
 * @param {{applied: number}} removals - `removalSummary` result.
 * @returns {string}
 */
export function removalCitable(label, removals) {
  if (typeof label !== 'string') return label;
  if (Number(removals?.applied ?? 0) !== 0) return label;
  return label.startsWith('measurement')
    ? 'measurement (product effect only; no removal measured)'
    : label;
}

/** The removal-to-ledger gate's name. */
export const REMOVAL_LEDGER_GATE =
  'fidelity: the journal\'s applied removals match the ledger\'s application_removals rows';

/**
 * The journal-to-ledger removal gate (fifteenth audit item 6).
 *
 * `result.json.removals` was journal-derived only, so a journal line that never
 * became a ledger row — or a ledger removal whose recall id is not in the
 * `recalls` table — was invisible. The expected side is the journal's applied
 * lane count; the actual side is the ledger's `application_removals` rows for
 * intents the ledger recorded as `applied` (the table is written at prepare
 * time, so rows for an abandoned intent are NOT applied removals). Every applied
 * row's `recall_id` must exist in `recalls`, or the removal has no restore path.
 *
 * Zero applied journal removals and zero applied ledger rows is `not-applicable`
 * (the lane was not exercised), never a measured equality.
 * @param {{journal: object|null, applied: {total: number,
 *   recallIds: string[]}|null, ledgerRecallIds: string[]|null,
 *   ledgerReadable?: boolean}} input
 *   - `applied` is the ledger read's applied-removal summary; null when the
 *     ledger could not state it (a pre-schema file or a missing column), which
 *     fails the gate by name rather than passing on silence.
 * @returns {{ok: boolean, class: string, detail?: string, journalApplied: number,
 *   ledgerApplied: number|null}}
 */
export function removalLedgerGate({ journal, applied, ledgerRecallIds, ledgerReadable = true }) {
  const journalApplied = Number(journal?.appliedRemovals ?? 0)
    + Number(journal?.landedEntries ?? 0)
    + Number(journal?.appliedForgets ?? 0);
  if (ledgerReadable === false) {
    return { ok: false, class: 'failed', journalApplied, ledgerApplied: null,
      detail: 'the ledger is absent or unreadable, so its applied removals cannot be compared to the journal' };
  }
  if (applied === null || applied === undefined) {
    return { ok: false, class: 'failed', journalApplied, ledgerApplied: null,
      detail: 'the ledger could not state its application_removals rows for applied intents '
        + '(a pre-schema file or an unreadable column); the journal count was not compared' };
  }
  const ledgerApplied = Number(applied.total ?? 0);
  if (journalApplied !== ledgerApplied) {
    return { ok: false, class: 'failed', journalApplied, ledgerApplied,
      detail: `the journal records ${String(journalApplied)} applied removal(s); the ledger holds `
        + `${String(ledgerApplied)} application_removals row(s) for applied intents` };
  }
  const held = Array.isArray(ledgerRecallIds) ? ledgerRecallIds : null;
  if (held === null) {
    return { ok: false, class: 'failed', journalApplied, ledgerApplied,
      detail: 'the ledger\'s recalls table was not read, so the applied recall ids cannot be checked' };
  }
  const missing = (Array.isArray(applied.recallIds) ? applied.recallIds : [])
    .filter((id) => !held.includes(id));
  if (missing.length > 0) {
    return { ok: false, class: 'failed', journalApplied, ledgerApplied,
      detail: `${String(missing.length)} applied removal(s) name a recall id absent from the ledger's `
        + `recalls table: ${missing.join(', ')}` };
  }
  return journalApplied === 0
    ? { ok: true, class: 'not-applicable', journalApplied, ledgerApplied,
      detail: 'no applied removal was recorded on either side; the removal lane was not exercised' }
    : { ok: true, class: 'measured', journalApplied, ledgerApplied,
      detail: `${String(journalApplied)} applied removal(s) are ${String(ledgerApplied)} ledger `
        + `row(s), and every applied recall id is in the recalls table` };
}
