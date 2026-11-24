# dsh mount example

The packages are not published to npm (owner decision, ISSUE-069). Build the mount, then point the
patch row at the built file. See `patch.yml`; the row shape is the one the test rig uses in
`dev/dsh-rig/run.mjs` (`mountRows`).

## Steps

1. Build from the repo root:

   ```sh
   npm install
   npm run build
   ```

2. Set `name` in `patch.yml` to the built entry:
   `file:///path/to/Agent-Memory-CREMATOR/packages/adapters/dsh/dist/plugin.js`. The checked-in row's
   `config` is already the full block under *Config*; only `name` needs the built path.

A bare `cremator-dsh/plugin` specifier resolves only after the package is installed into the profile;
the `file:///` form needs no install.

3. Boot with the overlay:

   ```sh
   dsh --profile headless --patch ./patch.yml "your task"
   ```

`dev/dsh-rig` runs this example against a loopback mock. A live route is a real run: read
`docs/guides/ref-live-testing.md`, keep evidence under `scratchpad/launch/<yyyy-mm-dd>-<slug>/`,
and keep the provider key out of argv, config, logs and evidence.

## Config

The entry reads these keys from the patch row (all optional):

| Key | Default | Meaning |
| --- | --- | --- |
| `barBytes` | `512` | Bulk-pass unit bar; a unit at or above it is a candidate (ADR-0051). |
| `floorBytes` | per-model table (`512` default) | Eligibility floor; absent lets the model table decide. |
| `episodeNoNewPathSteps` | `null` | Steps without a new path before a search episode closes. |
| `sealMaxLatencyTurns` | `1` | Turns a closed episode may wait before Seal replaces it. |
| `enforcement` | `apply` | A settled batch removes; `record-only` is the explicit opt-out (ADR-0008). |
| `contextWindowTokens` | `null` | Host window the apply leg plans against; needed for a depth bar. |
| `pruneThresholdTokens` | `null` | Absolute depth bar for the table pass (test value `60000`); requires a window. |
| `entryAskTrigger` | `off` | The per-result entry ask is retired (ADR-0050); an explicit `{ "mode": "count" }` keeps it with `entryAskBatchSize` (default `1`). |
| `entryAskGrammar` | `jsonl-20` | Entry ask grammar; `3option`, `two-option` and `jsonl-20-nokeepall` are selectable by name. |
| `pruneAskGrammar` | `nokeepall` | Bulk prune ask grammar; `3option` is the other selectable name (ADR-0056). |
| `nativeCompactionBackstop` | `true` | Host compaction re-arms the prune latch; `false` opts out. |
| `recordName` | `racoons/negation` | `source.kind` an appended negative fact carries. |
| `crematorStorageRoot` | `<DSH_HOME>/storages/cremator` | Durable root; each session gets `sessions/<sessionId>/ledger.sqlite` + `blobs/`. |

`capBytes` and `capHeadBytes` are accepted and ignored (ADR-0014); remove them from new rows.
`minCutFreedBytes` is accepted and ignored because the cut is the earliest forgotten node
(ADR-0034).

The checked-in `patch.yml` carries the full row below: `enforcement: apply` and both bars arm the
depth table, so it removes when the table fires. `record-only` is the explicit opt-out. A full row:

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
        pruneAskGrammar: nokeepall
        nativeCompactionBackstop: true
```

Storage is durable per session (ADR-0013), so recall ids survive a process restart. A host that owns
a ledger passes `openLedger` to `createRacoonsPlugin` instead of mounting the default instance.
Removals survive restart via the durable ledger (ADR-0015); a host-confirmed conflict blocks and
journals.
