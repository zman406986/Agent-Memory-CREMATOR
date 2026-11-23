# cremator-dsh

CREMATOR adapter for the dsh harness. Thin seam mapping, no policy: it translates dsh session
events into the public seams of `@cremator/core` and applies what the core guard approved. Every
removal is recorded in the trash ledger under a recall id. Project:
https://github.com/zman406986/Agent-Memory-CREMATOR.

## Install

The packages are not published to npm. Build from this repo, then point
the mount row at the built file:

```sh
npm install
npm run build
```

`dist/plugin.js` is the entry. A bare `cremator-dsh/plugin` specifier works only after the package is
installed into the dsh profile; a `file:///` name needs no install. Requires Node
`>=22.13.0 <23.0.0 || >=23.4.0`; `@cremator/core` resolves from the repo's workspace.

### Install as a dsh bundle

The package declares `dsh.bundle.patch` (`cordis.patch.yml`). Install the checkout into a profile
and select the bundle:

```sh
dsh plugin --profile <name> add link:<absolute package directory>
```

The host's Plugins page then lists `cremator-dsh`, and the profile records the bundle in
`dsh.profile.bundles`. The bundle patch inserts the mount with the example config; a profile patch
after it can override any key. Do not also insert the row by hand: two rows with one id make the
settings form unaddressable. The `file:///` row below remains the no-install route.

### Installing from tarballs

`npm pack` in `packages/core` and in this package produces `cremator-core-0.1.0.tgz`
and `cremator-dsh-0.1.0.tgz`. This package declares
`"@cremator/core": "^0.1.0"`, and nothing is on the registry, so installing
only the adapter tarball tries to fetch core from npm and fails. Install the core
tarball first, or point npm at it with an `overrides` entry in the consuming
project's `package.json`:

```json
{
  "overrides": {
    "@cremator/core": "file:./cremator-core-0.1.0.tgz"
  }
}
```

Then `npm install ./cremator-dsh-0.1.0.tgz` adds both packages. Keep the
tarballs in the consuming project's directory or adjust the `file:` path.
Verified 2026-11-23 with npm 11.17.0: the adapter alone exits 1 on the unresolved
core dependency; the override installs two packages; installing the core tarball
first also works.

## Use

The mount entry is the subpath export; the package's default entry has no host dependency.

`dsh --patch` row:

```yaml
- insert:
    - id: cremator-mount
      name: 'file:///path/to/Agent-Memory-CREMATOR/packages/adapters/dsh/dist/plugin.js'
      config:
        barBytes: 512
        enforcement: apply
        contextWindowTokens: 400000
        pruneThresholdTokens: 60000
        entryAskTrigger: { mode: 'off' }
        entryAskGrammar: jsonl-20
        nativeCompactionBackstop: true
```

The entry is a Cordis plugin (`name`, `inject`, `apply`) and also exports a default instance, so a
`file:///` specifier or a bare package specifier both work. Replace the example URL with the
path of your own checkout:
`file:///path/to/Agent-Memory-CREMATOR/packages/adapters/dsh/dist/plugin.js`. Config keys are the
mount's flat knobs:
`barBytes`, `floorBytes`, `episodeNoNewPathSteps`, `sealMaxLatencyTurns`, `minCutFreedBytes`,
`enforcement`, `recordName`, `anchors`, `judgeTimeoutMs`, `crematorStorageRoot`,
`contextWindowTokens`, `pruneThresholdTokens`, `nativeCompactionBackstop`, `entryAskTrigger`,
`entryAskGrammar`, `pruneAskGrammar`, `entryAskBatchSize`, `dedupeSupersededByReread`,
`dedupeCallEcho`.

### The `/cremate` command

When the host exposes its command registry (`commands`), the mount registers `cremate`; the slash
menu lists `/cremate`. The command records a manual prune request and opens a `/cremate` user turn,
so the next `agent/pre-step` runs the pass. A typed `/cremate` message still triggers the same pass
on a host without the command seam.

Defaults that matter: `barBytes` 512, `enforcement` `apply` (`record-only` is the explicit opt-out),
`entryAskGrammar` `jsonl-20`, `pruneAskGrammar` `nokeepall`, and
`nativeCompactionBackstop` `true`. `contextWindowTokens` is the host window the apply leg plans
against; `pruneThresholdTokens` is the absolute depth bar (test value 60,000) and requires the window.
`entryAskTrigger: { mode: "off" }` is the product configuration: the per-result entry ask is retired
and the entry seam stays for compatibility.

`capBytes` and `capHeadBytes` are accepted and ignored: the entry-time size cap was scrapped, so an
old config file still mounts and neither value is read. Remove them from new rows.
`minCutFreedBytes` is also accepted and ignored: the cut is the earliest forgotten node.

## Durable storage

Storage is durable per session: session `N`'s trash ledger is
`<crematorStorageRoot>/sessions/N/ledger.sqlite` with its blobs in the sibling `blobs/`
directory. Removals survive a restart via the durable ledger; a host-confirmed
conflict blocks and journals.

Only the storage root is configurable; a per-session path pair (`databasePath` + `blobRoot`) is
refused with `explicit-storage-paths`, because one shared ledger would break the per-session rule.

`crematorStorageRoot` is the config key. It must be absolute. Absent, it resolves to
`<DSH_HOME>/storages/cremator`, where `DSH_HOME` defaults to `~/.dsh`. The `storages` level
is dsh's own storage root; `cremator` is a subdirectory, so no dsh file
is ever shared — CREMATOR stamps its own `application_id` and `user_version`, and a shared file
would be unreadable by both sides.

A host that owns durable storage may pass its own `openLedger` instead:

```ts
import { createRacoonsPlugin } from 'cremator-dsh';

const plugin = createRacoonsPlugin({
  config: { enforcement: 'apply', barBytes: 512,
    crematorStorageRoot: '~/.dsh/storages/cremator' },
  journal: (record) => console.error(record.kind),
});
// mount: await plugin.apply(ctx)
```

The mount journals one `mounted` record carrying `ledgerSource`
(`'durable' | 'host' | 'memory'`), `node` (`process.version`) and, for the durable source,
`storageRoot` — runtime evidence of where the ledger actually landed.

`':memory:'` is for tests only, through the programmatic `storage` option; no config value
selects it.

### Degradation

- **The ledger cannot open** (the path is unreadable, occupied, or otherwise failing): the mount retries
  the open once at the next step boundary, warning and journaling `storage-retry` for the first
  failure. If the retry also fails, it installs a refusing ledger and journals `storage-unavailable`
  once with the code, path and runtime; every removal is then refused with a typed `storage` error.
  The session degrades to `recovery-pending`, the transcript is never touched, and recall of ids this
  process never minted fails as `not-found`. A retry that succeeds journals `storage-recovered` and
  the mount is fully live.
- **A restart keeps removals live.** The durable ledger's `applied` receipts are the record of
  record: a fresh port answers `unknown` for an intent it never saw, and the removal
  still counts as applied. A host that positively answers `not-applied` contradicts the ledger:
  the pass blocks and journals a `receipt-conflict`. Recall is a read of the durable ledger and
  keeps working either way.
- **Retention.** Archived bytes live until the user deletes the session directory. There is no
  automatic deletion and no expiry in v1.
- **Scope.** A recall id resolves within the session that minted it, including after a restart or
  resume of that session. Cross-session recall is out of scope.

The `necromancy` model-facing tool returns the projected output (`recallId`, `text`, `byteLength`,
`parts`), never the ledger record's `Uint8Array` parts: dsh requires every tool value to be
lossless JSON. The `forget` tool answers from the session's live snapshot and the mount applies an
admitted request at its next step or turn-end boundary, as one revert plus one receipt.

## Status

Append-mode Seal is enforced; the entry-time cap is scrapped. Verdict
enforcement defaults to `apply`; `record-only` is the explicit opt-out. The
stale-read and superseded-read proof rules ship and run in the mount's at-rest pass. Per-call usage reconciliation from the host's `assistant/message` row is wired. The per-path coverage meter's rows ride `SessionSnapshot.pathCoverage`, and the recall source-fallback reader is wired (`recallReader`, `recallFromSource`).

## License

Apache-2.0.
