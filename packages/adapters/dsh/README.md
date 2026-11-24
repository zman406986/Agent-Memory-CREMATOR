# cremator-dsh

CREMATOR adapter for the dsh harness. Thin seam mapping, no policy: it translates dsh session
events into the public seams of `@cremator/core` and applies what the core guard approved. Every
removal is recorded in the trash ledger under a recall id. Project:
https://github.com/zman406986/Agent-Memory-CREMATOR.

## Install

```sh
npm install cremator-dsh
```

`@cremator/core` installs as a dependency. Requires Node
`>=22.13.0 <23.0.0 || >=23.4.0`.

Host: `@deepseek-ai/dsh`, declared as an optional peer with the open range
`>=0.0.0-0`.
Tested against `0.2.1-rc.2` and `0.2.2-rc.1`. Any older or newer host resolves
and is accepted: the adapter never refuses a host by version, so a future dsh
keeps mounting.

### Install as a dsh bundle

The package declares `dsh.bundle.patch` (`cordis.patch.yml`). Add it to a profile:

```sh
dsh plugin --profile <name> add cremator-dsh
```

The host's Plugins page then lists `cremator-dsh`, and the profile records the
bundle in `dsh.profile.bundles`. The bundle patch inserts the mount with the
example config; a profile patch after it can override any key. Do not also
insert the row by hand: two rows with one id make the settings form
unaddressable.

For a local checkout, run `npm install && npm run build`, then use
`dsh plugin --profile <name> add link:<absolute package directory>`.

## Use

The mount entry is the subpath export; the package's default entry has no host dependency.

`dsh --patch` row:

```yaml
- insert:
    - id: racoons-mount
      name: 'file:///C:/Users/TZhen/Desktop/racoons/packages/adapters/dsh/dist/plugin.js'
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
`file:///` specifier or a bare package specifier both work. The example URL is for the
`C:\Users\TZhen\` device; on the other use
`file:///C:/Users/TZ/Desktop/racoons/packages/adapters/dsh/dist/plugin.js`. Config keys are the
mount's flat knobs:
`barBytes`, `floorBytes`, `episodeNoNewPathSteps`, `sealMaxLatencyTurns`, `minCutFreedBytes`,
`enforcement`, `recordName`, `anchors`, `judgeTimeoutMs`, `crematorStorageRoot`,
`contextWindowTokens`, `pruneThresholdTokens`, `nativeCompactionBackstop`, `entryAskTrigger`,
`entryAskGrammar`, `pruneAskGrammar`, `entryAskBatchSize`, `dedupeSupersededByReread`,
`dedupeCallEcho`.

### The `/cremate` command

When the host exposes its command registry (`commands`), the mount registers `cremate`; the slash
menu lists `/cremate`. The command card reports the pass directly: the handler registers the
request for a CREMATOR marker message, opens that marker turn through `agent.followup`, and awaits
the pass the turn's `agent/pre-step` runs inside the open turn. The marker step is then rejected,
so the model sees no `/cremate` message and the turn sends no request; the marker carries the
command's id as `source.commandId`. The pass must run inside a turn because the host's session log
accepts a tool-result surface replacement only with an open turn; running it from the handler
corrupts the stored session (ISSUE-535). A typed `/cremate` message keeps its queued path: it marks
the session and the next `agent/pre-step` runs the pass.

Defaults that matter: `barBytes` 512 (ADR-0051), `enforcement` `apply` (ADR-0008; `record-only` is
the explicit opt-out), `entryAskGrammar` `jsonl-20`, `pruneAskGrammar` `nokeepall` (ADR-0056), and
`nativeCompactionBackstop` `true`. `contextWindowTokens` is the host window the apply leg plans
against; `pruneThresholdTokens` is the absolute depth bar (test value 60,000) and requires the window.
`entryAskTrigger` defaults to `{ mode: "off" }`: the per-result entry ask is retired (ADR-0050), and
the entry seam stays for compatibility. An explicit `{ mode: "count" }` selects the retired
per-result cadence; `entryAskBatchSize` applies only on that path.

`capBytes` and `capHeadBytes` are accepted and ignored since 2026-10-23: ADR-0014 scrapped the
entry-time cap, so an old config file still mounts and neither value is read. Remove them from new
rows. `minCutFreedBytes` is also accepted and ignored: the cut is the earliest forgotten node
(ADR-0034).

## Durable storage

Storage is durable per session (ADR-0013): session `N`'s trash ledger is
`<crematorStorageRoot>/sessions/N/ledger.sqlite` with its blobs in the sibling `blobs/`
directory. Removals survive a restart via the durable ledger (ADR-0015); a host-confirmed
conflict blocks and journals.

Only the storage root is configurable; a per-session path pair (`databasePath` + `blobRoot`) is
refused with `explicit-storage-paths`, because one shared ledger would break the per-session rule.

`crematorStorageRoot` is the config key. It must be absolute. Absent, it resolves to
`<DSH_HOME>/storages/cremator`, where `DSH_HOME` defaults to `~/.dsh`:
`C:\Users\TZhen\.dsh\storages\CREMATOR` on one owner device, `C:\Users\TZ\.dsh\storages\CREMATOR`
on the other. `storages` is dsh's own storage root; `CREMATOR` is a subdirectory, so no dsh file
is ever shared — CREMATOR stamps its own `application_id` and `user_version`, and a shared file
would be unreadable by both sides.

A host that owns durable storage may pass its own `openLedger` instead:

```ts
import { createRacoonsPlugin } from 'cremator-dsh';

const plugin = createRacoonsPlugin({
  config: { enforcement: 'apply', barBytes: 512,
    crematorStorageRoot: 'C:/Users/TZhen/.dsh/storages/cremator' },
  journal: (record) => console.error(record.kind),
});
// mount: await plugin.apply(ctx)
```

The mount journals one `mounted` record carrying `ledgerSource`
(`'durable' | 'host' | 'memory'`), `node` (`process.version`) and, for the durable source,
`storageRoot` — the runtime evidence ADR-0013 ruling 8 asks for.

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
  record (ADR-0015): a fresh port answers `unknown` for an intent it never saw, and the removal
  still counts as applied. A host that positively answers `not-applied` contradicts the ledger:
  the pass blocks and journals a `receipt-conflict`. Recall is a read of the durable ledger and
  keeps working either way.
- **Retention.** Archived bytes live until the user deletes the session directory. There is no
  automatic deletion and no expiry in v1.
- **Scope.** A recall id resolves within the session that minted it, including after a restart or
  resume of that session. Cross-session recall is out of scope (ADR-0013 ruling 7).

The `necromancy` model-facing tool returns the projected output (`recallId`, `text`, `byteLength`,
`parts`), never the ledger record's `Uint8Array` parts: dsh requires every tool value to be
lossless JSON. The `forget` tool answers from the session's live snapshot and the mount applies an
admitted request at its next step or turn-end boundary, as one revert plus one receipt.

## Status

Append-mode Seal is enforced; the entry-time cap is scrapped (ADR-0014, 2026-10-23). Verdict
enforcement defaults to `apply` (ADR-0008); `record-only` is the explicit opt-out. The
stale-read and superseded-read proof rules ship and run in the mount's at-rest pass (ISSUE-045
C3). Per-call usage reconciliation from the host's `assistant/message` row is wired (ISSUE-045
D1). The per-path coverage meter's rows ride `SessionSnapshot.pathCoverage`, and the recall
source-fallback reader is wired (`recallReader`, `recallFromSource`).

## License

Apache-2.0.
