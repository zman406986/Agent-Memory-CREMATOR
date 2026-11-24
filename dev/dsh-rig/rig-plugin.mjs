/**
 * RACOONS mount for the dsh test rig — a thin wrapper over the SHIPPED entry.
 *
 * Contract this file lives under: the mount's host mapping (turn/step
 * numbering, turn-end completion, no-agent fallback, publication shapes) and
 * its durable storage seam (ADR-0013) are product code now, in
 * `packages/adapters/dsh/src/{plugin,storage}.ts`. This file only adapts the
 * rig's harness concerns onto that entry:
 *
 *   1. load the compiled plugin from the dist tree (a dsh child does not strip
 *      TypeScript), via `CREMATOR_RIG_DIST` — unset is a refusal, never a guess;
 *   2. route the entry's journal into `<evidenceDir>/cremator-events.jsonl`;
 *   3. point `crematorStorageRoot` at a throwaway directory under the evidence
 *      dir, so the entry opens its own per-session SQLite file there and the
 *      driver can recall from a closed database in a later process. The rig
 *      supplies no ledger: the seam under test is the product's own.
 *
 * The rig config is the entry's own config plus two harness keys
 * (`evidenceDir`, `log`). Everything else passes through.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Stable Cordis plugin name: the shipped entry's. */
export const name = 'racoons';

/** Services the plugin needs before dsh applies it; mirrors the shipped entry. */
export const inject = ['llm', 'sessions'];

/** The evidence file the driver's `expect.racoons` checks read. */
export const EVIDENCE_FILE = 'cremator-events.jsonl';

/** The per-session layout the entry's `storage.ts` writes (ADR-0013). */
export function sessionLedgerPaths(storageRoot, sessionId) {
  const sessionDir = join(storageRoot, 'sessions', sessionId);
  return { sessionDir, ledgerPath: join(sessionDir, 'ledger.sqlite'),
    blobRoot: join(sessionDir, 'blobs') };
}

/**
 * Import the compiled workspace. One import per process; the dist tree is
 * produced by `build-dist.mjs` before any dsh launch.
 * @param {string} dist - the dist root.
 */
export async function loadShippedPlugin(dist) {
  if (typeof dist !== 'string' || dist === '') {
    throw new Error('racoons-mount: CREMATOR_RIG_DIST is not set; run dev/dsh-rig/build-dist.mjs and launch through run.mjs');
  }
  const entry = await import(pathToFileURL(join(dist, 'packages', 'adapters', 'dsh', 'src',
    'plugin.js')).href);
  const core = await import(pathToFileURL(join(dist, 'packages', 'core', 'src', 'index.js')).href);
  if (typeof entry.createRacoonsPlugin !== 'function') {
    throw new Error(`racoons-mount: ${dist} carries no createRacoonsPlugin; rebuild the dist tree`);
  }
  return { ...entry, core };
}

/**
 * The entry knobs this wrapper forwards, in one named list. Everything else in a
 * scenario's config is dropped here rather than reaching the entry (the two
 * harness keys `evidenceDir`/`log` are not entry config at all).
 *
 * The list is checked against the entry's own exported surface
 * (`racoonsPluginConfigKeys()`) by `rig-plugin.test.mjs`: a mount key added to
 * the product without a matching entry here fails that test by name, instead of
 * silently reverting to its default at the mount. That is exactly how
 * `entryAskTrigger` and `entryAskGrammar` were lost on the 2026-10-31 full run
 * (ISSUE-131).
 */
export const RIG_PLUGIN_CONFIG_KEYS = Object.freeze([
  'capBytes', 'capHeadBytes', 'episodeNoNewPathSteps', 'sealMaxLatencyTurns',
  'barBytes', 'minCutFreedBytes',
  // ADR-0028: `anchors` is accepted-and-ignored by the entry (the entry ask
  // renders its anchors unconditionally), and `judgeTimeoutMs` is the bulk
  // prune's ask deadline. Both stay forwarded so a scenario that names them
  // reaches the mount unchanged; the three protocol keys the judge pass and
  // its turn gate tuned (retryLimit, revisitShare, advertisedLabelLimit) are
  // gone with the pass and are no longer forwarded.
  'enforcement', 'recordName', 'anchors', 'judgeTimeoutMs',
  // The entry checkpoint's size floor (ISSUE-058 chunk P3d; ADR-0020 §3). A
  // scenario that states it must reach the mount unchanged, or the E2E would
  // be measuring the per-model default instead of the floor it names.
  'floorBytes',
  // The batched entry-ask cadence (ISSUE-117 chunk B3; ADR-0035). A scenario
  // that states a batch must reach the mount unchanged, or the rig would
  // measure the shipped per-result cadence while claiming a batch.
  'entryAskBatchSize',
  // The dedupe classes (ADR-0037 decision 6; ISSUE-145; ISSUE-151). Both ship
  // off, so a scenario that turns one on must reach the mount unchanged —
  // otherwise the rig would measure the shipped no-dedupe prune while claiming
  // the pass ran (ISSUE-161).
  'dedupeSupersededByReread', 'dedupeCallEcho',
  // ISSUE-128 / ISSUE-129: what fires the batched ask and the grammar it
  // states. Both are the live run's configuration; dropping either is how the
  // 2026-10-31 run measured count + 3option while its patch named
  // landed-bytes + two-option (ISSUE-131).
  'entryAskTrigger', 'entryAskGrammar',
  // ISSUE-221: the bulk prune ask's grammar. A scenario that states `nokeepall`
  // must reach the mount unchanged, or a scenario naming the two-verdict
  // contract could silently measure another grammar (ADR-0056 makes `nokeepall`
  // the mount's shipped default).
  'pruneAskGrammar',
  // ISSUE-022 chunks 5–6; ADR-0050 decision 2: the trigger's denominator, the
  // absolute bar that supersedes it, and the native-compaction backstop. All
  // three are the entry's own config, so a scenario that states a bar must
  // reach the mount unchanged.
  'contextWindowTokens', 'pruneThresholdTokens', 'nativeCompactionBackstop',
]);

/**
 * Split the rig's flat config into the shipped entry's knobs and the harness
 * paths. Unknown keys are dropped here rather than reaching the entry.
 *
 * `crematorStorageRoot` is the entry's own key (ADR-0013 ruling 3) and is always
 * made explicit: derived under the evidence dir when the scenario names none,
 * so the default `~/.dsh` root is never touched by a rig run.
 * @param {object} rawConfig
 */
export function splitRigConfig(rawConfig) {
  const config = rawConfig !== null && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
    ? rawConfig : {};
  const evidenceDir = typeof config.evidenceDir === 'string' ? config.evidenceDir : null;
  const storageRoot = typeof config.crematorStorageRoot === 'string'
    ? config.crematorStorageRoot
    : evidenceDir === null ? null : join(evidenceDir, 'storage');
  const plugin = {};
  for (const key of RIG_PLUGIN_CONFIG_KEYS) {
    if (config[key] !== undefined) plugin[key] = config[key];
  }
  if (storageRoot !== null) plugin.crematorStorageRoot = storageRoot;
  return { plugin, evidenceDir, storageRoot, log: config.log !== false };
}

/**
 * The journal sink: one JSON line per record, appended to the evidence file.
 * A missing evidence dir disables the file (the driver always supplies one).
 * @param {{evidenceDir: string|null, log: boolean}} paths
 */
export function evidenceSink(paths) {
  if (!paths.log || paths.evidenceDir === null) return () => {};
  mkdirSync(paths.evidenceDir, { recursive: true });
  const file = join(paths.evidenceDir, EVIDENCE_FILE);
  return (record) => {
    try { appendFileSync(file, `${JSON.stringify(record)}\n`); }
    catch { /* evidence only, never control flow */ }
  };
}

/**
 * Mount the shipped entry. dsh calls this with its own context and the
 * `--patch` row's config. No `openLedger`: the entry's own durable seam is
 * what the rig proves, so the wrapper must not substitute for it.
 *
 * @param {object} ctx - Cordis plugin context (`ctx.on`, `ctx.sessions`, `ctx.logger`).
 * @param {object} [rawConfig] - the patch row's config.
 */
export async function apply(ctx, rawConfig) {
  const runtime = await loadShippedPlugin(process.env.CREMATOR_RIG_DIST);
  const paths = splitRigConfig(rawConfig);
  const sink = evidenceSink(paths);
  const plugin = runtime.createRacoonsPlugin({
    config: paths.plugin,
    journal: sink,
  });
  sink({ kind: 'rig-mount', atMs: Date.now(), dist: process.env.CREMATOR_RIG_DIST ?? null,
    entry: 'cremator-dsh/plugin', evidenceDir: paths.evidenceDir,
    crematorStorageRoot: paths.storageRoot });
  await plugin.apply(ctx, paths.plugin);
}
