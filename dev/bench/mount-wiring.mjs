/**
 * Which entry the racoons arm mounts, and whether a journal is expected.
 *
 * Extracted from `bench-run.mjs` so the decision is testable without launching
 * a run (the launcher guards `await main()` behind `invokedDirectly`). The
 * launcher reads ONE object from here and uses both fields, so the entry it
 * loads and the journal gate it arms can never disagree.
 *
 * The defect this closes (ISSUE-082): the wrapper — the only thing that hands
 * the shipped entry a `journal` sink — was chosen on `replay !== null`, i.e.
 * `--provider mock-replay` only. Every live-route run mounted the shipped entry
 * directly, whose default entry passes no sink, so each `journal(kind, fields)`
 * call was constructed and dropped. Live run B left 175 ledger rows and zero
 * journal lines.
 *
 * Two facts are deliberately separate:
 *
 *   - `rigWrapper` is true when nothing overrides the entry on a gated route.
 *     The wrapper supplies the sink and the `crematorStorageRoot`.
 *   - `journalGated` is true for every racoons run on a gated route, whether or
 *     not the wrapper is mounted. `--plugin-entry` naming the shipped entry
 *     REMOVES the sink (that is the perturbation) but must never disarm the
 *     gate, or the red-proof would pass by silence.
 */

/** Providers whose racoons arm must leave a journal: replay and the real routes. */
const JOURNAL_GATED_PROVIDERS = new Set(['mock-replay', 'deepseek-official', 'deepseek-v4-pro']);

/**
 * @param {{arm: string|null, provider: string, pluginEntry: string|null}} input
 * @returns {{rigWrapper: boolean, journalGated: boolean}}
 */
export function chooseMountEntry({ arm, provider, pluginEntry }) {
  const journalGated = arm === 'racoons' && JOURNAL_GATED_PROVIDERS.has(provider);
  return { rigWrapper: journalGated && pluginEntry === null, journalGated };
}

/**
 * The journal line only the mount can write: `mounted`, carrying the storage
 * root the mount actually opened (ADR-0013 ruling 8 — runtime evidence comes
 * from inside the mount). The file's presence is not enough; a hand-written
 * stub with plausible `entry-ask-*` lines must fail here.
 *
 * @param {object|null} journal - the `journalState` result.
 * @param {string|null} expectedStorageRoot - the root the launcher configured.
 * @returns {{ok: boolean, detail?: string}}
 */
export function mountedLineGate(journal, expectedStorageRoot) {
  if (journal === null || journal === undefined || journal.journal === null || journal.journal === undefined) {
    return { ok: false, detail: 'the mount supplied no sink: no cremator-events.jsonl was written' };
  }
  const mounted = journal.journal.mounted ?? null;
  if (mounted === null) {
    return { ok: false,
      detail: 'the journal carries no mounted line; only the mount writes one, so a stub cannot satisfy this gate' };
  }
  // A durable mount names `storageRoot`; the memory pair names `storage`.
  const named = mounted.storageRoot ?? mounted.storage ?? null;
  if (named !== expectedStorageRoot) {
    return { ok: false,
      detail: `the mounted line names storage ${JSON.stringify(named)}, `
        + `expected ${JSON.stringify(expectedStorageRoot)}` };
  }
  return { ok: true };
}
