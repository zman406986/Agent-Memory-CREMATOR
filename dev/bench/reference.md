# Bench reference — history, key lists, evidence inventory

Companion to `dev/bench/runbook.md`. The runbook is what to run; this file is
what to read when auditing a finished run or changing the launcher. Both are
permanent: one shelf, no `scratchpad/` citations. Synthetic pressure:
`dev/bench/ref-synthetic-pressure.md`.

## What prep.mjs writes

`dev/bench/prep.mjs` freezes the two arms and the template sibling:

- **The arms:** 1787 files, 20.1 MiB, `IDENTITY PASS`. Same bytes in both;
  the only differing manifest lines are `arm` and `identity.otherArm`.
- **The sibling:** `<root>/miliastra-game-template/`, 4523 files, 338.6 MiB at
  template `7f218bf`, with the arms' exclusions plus `.venv`/`venv`/`.tox` and
  its `build/` (1.5 GiB). Both manifests carry the sibling's source path, HEAD, dirty paths
  and totals, so the arm's `../miliastra-game-template/...` cites resolve.
  `--sibling` has **no default** (ISSUE-090): name the frozen copy
  (`…/racoons-bench/_sibling-parked-2026-10-27`), and the script refuses (exit 2)
  unless that copy hashes to this manifest's pin, `508b1eec…` over 4523 files,
  printing expected and actual.
`--dry-run` scans without writing and lifts the root-overlap guard, which is
why Step 5 can digest a finished arm in place. Re-running without `--force`
exits 2 by design; a root holding an entry the script never writes is refused
even with `--force`. A dirty source tree is allowed and recorded under
`source.dirtyPaths`; both arms get the same bytes.

## Launcher flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--arm` | required | `racoons` or `vanilla`; also picks the default arm dir and evidence dir |
| `--provider` | `mock` | `mock` (loopback mock, scratch work), `mock-replay` (same mock, script built from a record), or `deepseek-official` / `deepseek-v4-pro` (the official host; both need `--allow-official-spend`). The 2026-11-08 live route is `deepseek-official` / `deepseek-flash`; the official host is the only live provider (owner ruling 2026-11-09) |
| `--brief` | `dev/bench/bench-brief.md` | the fenced task under `## Task text` is the first user message, byte-for-byte |
| `--manifest` | none | round manifest under `dev/bench/manifests/`: the brief's fence sha256 and block size must match its `brief` block and the arm's multiset its `image.digest`; any mismatch is exit 2 before anything is wiped. A `brief` with no `image.digest` is refused (the brief binds an image it does not name), and a round manifest with a digest but no arm `manifest.json` prints the image-half skip by reason. A paid launch (`deepseek-official`, `deepseek-v4-pro`) must name it: the refusal comes before anything is wiped, and `--preflight` is exempt because it spends nothing. The arm tree is hashed before the launch on every run and compared to `image.digest`; `result.json.tree` records `{checked: true, digest}` |
| `--kill-ms` | `0` (off) | optional wall-clock cap; 0 arms no timer, so the token grant is the only run cap. A positive value arms `taskkill /PID <pid> /T /F` before any wait. A negative value or a fraction refuses |
| `--token-grant` | none | in-run spend ceiling in the TRUE total (main prompt + main output + ask prompt + ask output, read from the session log and the mount's journal; the prompt component is input + cacheRead + cacheWrite, the sum `session-usage.mjs` computes); the session log is polled and the tree is killed at the grant, like the kill box; absent = no ceiling. The 2026-11-08 2-option run's grant is **60,000,000**; its alarm is `--warn 48000000 --stop 60000000` on the TRUE reading (advisory, exit 3; it kills nothing). The absolute rule ceiling remains 100,000,000 billed prompt tokens; a grant above 100,000,000 would pay past the rule before stopping. The grant meters the TRUE total, so the ask lane is inside it and is also recorded in `result.json.askLane`. A usage row with no recognizable prompt-side token field (a renamed field) refuses the run: it is not summed as 0, `watchdog.usageReadingRefused` is true, and the coverage row fails. The watchdog states `polls` and `error`; a non-null `error` fails `the token grant was readable`, a 0 reading with assistant turns in the log fails `the token grant measured every step`, and the final poll flushes a last session line with no newline |
| `--stop-on-compaction` | off | stop at the session's FIRST native compaction (`compaction/start`), not a budget: same kill path, run labelled `stopped-on-compaction`, exit 1; `result.json` carries `stoppedOnCompaction` and the crossing's step/seq/billed total; `launch-contract.md` § "The three stoppers" |
| `--stop-at-checkpoint` | none | stop when a file appears under the arm dir (relative path, no `..`, absent at launch): same kill path, run labelled `stopped-at-checkpoint`, exit 1; **censored partial**, not a pass and not a failure. Goes through the normal result path: `result.json.stoppedBy`, `result.json.stop` (checkpoint path/billed total/compactions/`killLanded`, `benchDone.found`, `deliverablesCreated`, `largestCheckpointReached`, `largestCommonK`, `peak`, `compaction.atRequests`, `journalTotals`, `askLane`); claims are gated on `stop.benchDone.found`, never `passed`. The 2026-11-08 2-option run uses k=8 (`docs/plans/2026-10-27-extended-audit/07-plan-traceability.md`) |
| `--stop-after-compactions` | none | stop at the Nth native compaction, same censored-partial rule and result path, name `stopped-after-compactions`; positive integer. It is an independent guard beside `--stop-at-checkpoint`; **not armed** on the 2026-11-08 2-option run (the control's second compaction is past k=13) |
| `--allow-official-spend` | off | authorize the official DeepSeek host (`api.deepseek.com`). Required for `deepseek-official` and `deepseek-v4-pro` (any route whose base URL is the official host): without it a live run exits 2 and `--preflight` fails, and the six official rows stay disabled. With it those rows mount (including `web`/`tool-web`), preflight prints `spend=AUTHORIZED`, and `launch.json`/`result.json` carry `officialRoute` (`authorizedBy: "--allow-official-spend"`, ruling 2026-11-05). The 2026-11-08 2-option run pairs it with `--deny-web`, which re-closes the four web rows; preflight fails unless all four compose disabled. No effect on the mock lanes; `launch-contract.md` § "The official-endpoint opt-in" |
| `--deny-web` | off | re-close `web`, `web-search-deepseek`, `web-deepseek-api` and `tool-web` after `--allow-official-spend` skipped the default official rows. The disable rows are written after every row that could open them; preflight reads the composed dump and FAILS if any of the four is enabled. An absent row passes (the build cannot offer the tool). Both arms compose it |
| `--workspace-only` | off | strict read rule: any tool call naming a path outside the arm/world is a violation and the run exits 4. Cannot be combined with `--allow-read`. `readBoundary.workspaceOnly` is true in `result.json`; the host's `danger-full-access` mode remains a post-hoc gate, not an OS sandbox |
| `--prune-ask-grammar` | `nokeepall` | racoons arm only: the bulk table's answer grammar. `nokeepall` is the shipped default (ADR-0056): `forgetall` and `keeplines` only, sent as the `jsonl-20-nokeepall` three-piece entry message (`entryBatchAskMessage`: pre-table contract, table with each row's `[L line(s)]`, post-table repeat with the worked example and end anchor; 70 percent share on the first ask, 40 percent later); a whole unit is a full-range `keeplines` with its answer key `forgotten` set to `None` (the value names the dropped content; legacy `summary` is accepted), and a literal `keepall` is a terminal `action-not-in-grammar` refusal that keeps the row (ADR-0053). `3option` stays selectable by name and is the original contract byte for byte (`PRUNE_ASK_SYSTEM_PROMPT`: `keepall`, `keeplines`, `forgetall`). The 2026-11-08 2-option run passes `nokeepall`, on `deepseek-official` / `deepseek-flash` with the 512-byte eligibility floor (ADR-0051) |
| `--root` | `C:/Users/TZhen/Desktop/racoons-bench/2026-10-23-taskworld` | material root |
| `--arm-dir` | `<root>/<arm>-arm` | explicit arm override (`_pristine/<arm>-arm` for a re-run) |
| `--plugin-dist` | `scratchpad/dsh-rig/dist` | built by `dev/dsh-rig/build-dist.mjs`; the launcher runs `ensureDist` |
| `--plugin-entry` | `mock-replay`/a real route: `dev/dsh-rig/rig-plugin.mjs`; `mock`: the shipped entry | the mount entry; always wins. A launch with `--arm vanilla` is refused: the vanilla arm loads no mount, so the flag would be silently ignored (`--preflight` is exempt: it mounts nothing) |
| `--perturb-journal-caps` | none | **perturbation only**: shift the journal's cap count in memory; the run must fail by name; refuses `--projection-out` |
| `--perturb-journal-parse` | off | **perturbation only**: append a non-JSON line; the run must fail by name; refuses `--projection-out` |
| `--evidence` | as above per provider | overrides the evidence dir |
| `--dry-work` | off | copy the arm to `<evidence>/work/`; required with `--provider mock` and `mock-replay` |
| `--preflight` | off | resolve, `patch.yml`, `--dump-config`; spends nothing |
| `--require-done` | off | assert a `BENCH-DONE` assistant message |
| `--mock-script` | `dev/bench/mock-smoke.script.json` | scripted turns (`--provider mock`) |
| `--record` | none | `--provider mock-replay` only: the `.zcode` `transcript.jsonl` to replay |
| `--record-map` | none | `--provider mock-replay` only: the committed path map binding that record |
| `--port` | 0 | mock port; 0 = OS picks |
| `--dsh-bin` | global `@deepseek-ai/dsh/lib/bin.js` | explicit dsh entry |
| `--projection-out` | none | `--provider mock-replay` only: write this run's projection after a green run |
| `--projection-in` | none | `--provider mock-replay` only: compare to a stored projection; any diff fails by name |
| `--perturb-swap-match` | none | **perturbation only**: swap two replies' matchers; the run must fail by name; refuses `--projection-out` |
| `--omit-deny-rows` | off | **perturbation only**; the probe must fail |
| `--inflate-bytes` | off | **mock-replay only**: filler pads each scripted shell result to ≥ N bytes; the racoons arm's tool-result pruner is off (ADR-0041; `--allow-host-pruner` is its opt-out), so the row measures `compaction-basic` alone, while the vanilla arm keeps the pruner at the host default (ADR-0055) and trims the filler; `ref-synthetic-pressure.md`. Not needed for pressure: a long real record reaches the trigger itself, so the host compaction lane is served on every replay run |
| `--allow-host-pruner` | off | **opt-out (racoons arm)**: leave the host's own `tool-result-pruner` mounted. The state is arm-dependent on every provider (ADR-0055), and it is the arm's state, not a variable the bench sets: the vanilla arm writes no disable row, so the pruner keeps the host default (on), and its `compaction/prune` events are the host's own work, accounted as that arm's lane; the racoons arm disables it so the mount is the only remover and every removal is the product's. A racoons run that takes this flag is not a product measurement; on vanilla it is a no-op (`hostPruner.optOut` is null). `--end-pressure-isolation` is the same choice under its older spelling and still needs `--inflate-bytes`. `launch.json`/`result.json` carry `hostPruner` (`state`, `disabled`, `optOut`); `--preflight` fails when a racoons run has no `tool-result-pruner` row or leaves a copy enabled, and fails a vanilla run whose composed config lacks the row or disables one; a `compaction/prune` event fails a racoons run whose pruner was meant to be off |
| `--allow-zero-reasoning` | off | **void flag (ADR-0045)**: a measurement run whose session carries no reasoning, whose reasoning coverage is below the declared floor (`REASONING_TURN_COVERAGE_FLOOR`, 0.55 of assistant turns), or whose transcript lost one of the two structural sources (content parts / stream blocks) may proceed; `result.json.citableAs` then says `none (no reasoning measured)`, `reasoning.void` is true, and the reasoning row is class `void` (it never counts as a measured pass). Without the flag the run fails the `reasoning: the session carries the agent's reasoning` row. Not applicable to `mock` or `mock-replay` |
| `--world` / `--allow-read` / `--workspace-only` | none | **read boundary (ISSUE-039)**: per-arm layout world, a read-only allowance, and the strict workspace-only rule; exit codes and leg-B scoring too: `launch-contract.md`. The 2026-11-08 2-option run passes `--world` and `--workspace-only`, and no `--allow-read` |

Long records: `2026-10-24-fbfafdb6-combat-lock.json` (226 replies, 138 MiB) replays through converter v2's no-op family (`TaskOutput`/`TaskStop` → `job_list`).

Real-route base rows set `reasoningEffort: low` on `agent-default-model`. The map beside it offers `off`/`low`/`medium`/`max`, and `low` is valid on the official catalog too. Without an effort pi-ai sends `thinking: {"type":"disabled"}` on the DeepSeek provider, so the live run records zero reasoning and fails the reasoning gate. The row is written by the shared base rows, so both arms carry it.

The mount row, with the inert historical cap keys and the live seal bound. The
`capBytes`/`capHeadBytes` pair is ACCEPTED AND IGNORED (ADR-0014 decision 1,
restated product-wide by ADR-0048), so the row carries it only for an old config
to keep loading; `result.json.mount.capIgnored` says so, and
`capIgnoredSource: "declared"` states that the flag is a DECLARATION
(ADR-0014/ADR-0048), not a probe of the mounted build:

```yaml
- insert:
    - id: racoons-mount
      name: 'file:///C:/Users/TZhen/Desktop/racoons/dev/dsh-rig/rig-plugin.mjs'
      config: {"capBytes":8192,"capHeadBytes":8192,"sealMaxLatencyTurns":1,
               "evidenceDir":"…/racoons","crematorStorageRoot":"…/racoons/storage"}
```

Shipped entry: same shape. The `config` carries the same inert historical cap
keys and the live seal bound; no removal path reads the cap pair. Before bb33dc7
the wrapper also carried `ledgerPath`; it no longer injects a ledger (ADR-0013 —
the entry opens its own per-session file under `crematorStorageRoot`). Other
device: `C:/Users/TZ/Desktop/racoons/…`.

## What the native tool-result pruner does to the bill

The host pruner has two actions, and only the second changes the cached
prefix:

1. **Per-result truncation at arrival.** `thresholdChars: 8192`,
   `headChars: 4096`, `tailChars: 1024`: a result over 8,192 chars is sent as
   its first 4,096 plus its last 1,024 chars. It happens before the result is
   ever sent, so it costs no cache.
2. **An old-result sweep near the context limit.** The host emits one
   `compaction/prune` event per shadowed result, in bursts. The 32-file
   vanilla r1 recorded 42 events in two bursts (seq 466–522 and 916–940),
   206,548 shadowed tokens. The request after each burst pays the rewritten
   prefix: 159,711 and then 100,840 uncached tokens. Those 260,551 tokens are
   41.5% of the run's 627,155 uncached input ($0.039 at $0.15/M); the rest of
   the run stays 97.9% cached. The sweep saves 206,548 tokens from later
   requests, about $0.02–0.03 at $0.003/M, so it is close to a wash in
   dollars; its value is delaying compaction.

Arm shape (ADR-0055): vanilla keeps the pruner on, the racoons arm disables it
and must record zero `compaction/prune` events. The invalidation is inside the
vanilla arm's billed rows; no separate charge is added.

The ask lane's usage rows also carry `cachedInputTokens`, the cached part OF
`inputTokens` (`packages/adapters/dsh/src/usage.ts:19-22`). Price an ask as
`(input − cached) × $0.15/M + cached × $0.003/M`, not the whole prompt at the
uncached rate. In the 2026-11-09 32-file n=3 runs 83–86% of the ask prompt was
cached, so the ask lane costs $0.087–0.095 per run. Medians: product $0.340,
vanilla $0.271 (dollars +25.2%), product tokens −18.8%.

## Round-1 history (why the mock mode exists)

The first bench round (ISSUE-018) ran both arms against the then-current real route: both
hit the 5,400,000 ms box with no `BENCH-DONE`, each cost real tokens and 90
minutes, and neither could be re-run to check a harness change. The report is
`docs/research/bench-018-taskworld-2026-10-23.md` §8; every follow-up is another
paid run.

ISSUE-023 is the answer: `--provider mock-replay` replays a recorded zcode
session through both arms offline. It cannot measure update quality — a scripted
model does not read, adapt or update anything — so it measures harness parity
and context mechanics only. A record too short to build real context pressure
yields "no compaction" and must be reported as such, never as "compaction
avoided".

Design constraints found while building it, kept so they are not rediscovered:

1. The replay seam is `DEEPSEEK_BASE_URL` + `DEEPSEEK_API_KEY` in the child env;
   dsh's provider reads `DEEPSEEK_BASE_URL` from a trusted layer only.
2. The converter maps `Read`/`Bash`/`Grep`/`Glob`/`Edit`/`Write` and stops the
   prefix at the first unmappable call. A record from another repository names
   that repository's paths, so a path map is mandatory; a failed read still
   advances `tool_results_count`, so a broken map would replay silently.
3. `--dry-work` stays mandatory for both mock modes.
4. Deny leg B needs a `subagent` call in the script. A record almost never has
   one, so the deny proof stays on `mock-smoke.script.json`.
5. A racoons run on a journal-gated route (`mock-replay`, a real route) mounts the
   rig wrapper (journal sink + on-disk ledger); `mock` mounts the shipped entry
   directly, which has neither — see "The journal" below.
6. The mock fabricates usage (`estimateTokens(chars)`); a mock run's tokens are
   shape, not spend, and `result.json` says so with `usageIsEstimated: true`.
7. `maxReplies` defaults to 24; round-1 arms ran 232 assistant messages. A
   faithful mock arm needs a larger cap and a record long enough to build
   ≥150k tokens of context, or the compaction row is vacuous.

## The perturbation matrix

One perturbation per gate: a gate with no red run behind it is not evidence
(`docs/guides/law-verification-non-vacuity.md`).

| Gate | Perturbation | Expected |
| --- | --- | --- |
| record/map binding | map a target to a file absent from the arm | exit 2, `mapped target(s) absent` |
| path map | map `replay/file-5.md` to a file under 40 lines | `replay: no tool result failed on a path` |
| record binding | point `--record` at another record | exit 2, `sourceSha256 … does not match` |
| map shape | edit `turnCount` in the map | exit 2, `turnCount` mismatch |
| request keys | `--perturb-swap-match 3,4` | `fidelity: request keys match the served script per turn: request 3 (turn-03-tr4): expected tool_results_count 5, saw 4` |
| reply order | the same swap | `replay: consumed prefix 2 of 10 scripted replies; request 3: expected turn-03-tr4, matched turn-04-tr5` |
| determinism | hand-edit one `matched[i]` or `requests[i].tool_results_count` in the baseline | `canonical projection matches the stored baseline`, path `matched[2]` / `requests[4].tool_results_count` |
| deny probe | `--omit-deny-rows` | leg A fails: the header offers the six names |
| journal presence | `--plugin-entry <dist>/…/plugin.js` (no sink) | `fidelity: the racoons arm's journal is present and parsed` |
| cap archives | `--perturb-journal-caps 1` (a `cap` archive invented in memory) | `fidelity: no cap archives exist (ADR-0014)` |
| journal parse | `--perturb-journal-parse` (appends a non-JSON line) | `fidelity: the racoons arm's journal is present and parsed`, naming the line |
| prune lane | serve a racoons script with the 16 prune rows removed (`PRUNE_REPLY_CEILING` → 0) | `replay: no request went unmatched` (the table ask is a `no-match`), so the table-asks gate never gets a green run |
| pressure | `--inflate-bytes 80000` with the compaction rows removed | `replay: no request went unmatched` (the ask is a `no-match`) |
| host pruner | the launcher with `HOST_PRUNER_ROW` emptied on a racoons run (row never written; the launcher refuses more than one row, ADR-0041) | `host pruner: the composed config matches the run's choice: the composed config does not disable tool-result-pruner: …` |

The swap runs on a per-run copy of the converted script; the committed map and
any stored baseline are never touched, and `--perturb-swap-match` refuses
`--projection-out` so a red run cannot become a baseline.

## The projection

`buildProjection` (`bench-run.mjs`) writes `racoons-bench-projection/1`. Kept:

| Key | Meaning |
| --- | --- |
| `arm`, `provider` | identity of the run |
| `script_sha256` | the served script's bytes; a converter or map change moves it |
| `requests[]` | per main request: `tool_results_count`, `last_assistant_tool_names` |
| `matched[]` | which reply answered each request, in order; `replay-end` loses its ordinal |
| `tool_calls[]` | every tool call the host made, by name, in order |
| `tool_failures` | `count`/`by_code`/`by_tool` of failed results |

Dropped on purpose, because they move between two runs of the same arm:
timestamps, durations, absolute evidence paths, the mock's port, fabricated usage
rows, the title request (it races process exit), the terminator's ordinal.
Tool-result text is never included (absolute work path; filler under pressure). `script_sha256` IS a key, and inflation
DOES move it (3eab6ff7… vs 540a8a5c…): determinism is per mode, padded never
compared to unpadded. A racoons `script_sha256` also carries the prune prefix.

## Tool-failure constant

Five recorded `edit` calls replay as `FS_EDIT_NOT_FOUND`: their `old_string` is
prose from the source repository and no path map can make it match. The launcher
derives the expected multiset by simulating the served script's `edit`/`write`
calls over the frozen arm (first-occurrence replacement; only failure/success is
read back), so it knows how many failures the script itself causes. Any failure
outside that multiset is a defect, named with its tool, code, text.

## The journal

`dev/dsh-rig/rig-plugin.mjs` is the wrapper that routes the entry's journal to
`<evidenceDir>/cremator-events.jsonl` and points the entry's `crematorStorageRoot`
at `<evidenceDir>/storage` (ADR-0013: the entry opens its own per-session
`ledger.sqlite` there; the wrapper injects none). A racoons run on a
journal-gated route (`mock-replay` AND a real route — ISSUE-082) mounts that
wrapper (`bench-run.mjs`: `rigWrapper`, from `mount-wiring.mjs`), so the racoons
arm writes both under `<evidence>/racoons/`. `mock` still mounts the shipped
entry (`packages/adapters/dsh/src/plugin.js`) directly, which has no sink and
keeps a `:memory:` ledger. `--plugin-entry` always wins on every provider, so
naming the shipped entry is the no-sink perturbation — and it does NOT disarm
the gate, so the run fails by name.

Kinds are the shipped entry's (`mounted`, `capabilities`, `entry`, `at-rest`,
`publish`, `skip`, `telemetry`, `entry-error`, `at-rest-error`) plus the
wrapper's `rig-mount`. A cap, an eviction or a verdict is a FIELD of a `publish`
record, not a kind, so the cap/seal/recall counts are derived: `capArchives`,
`evictArchives`, `verdictArchives` from `archives[].operationKind`,
`sealEpisodes` from `sealedEpisodeIds`, `negativeFacts` from `appendRecords`,
`recalls` from the `recall` telemetry. The applied-removal lanes the
replacement gate compares against (`appliedRemovals`, `landedEntries`,
`appliedForgets`, `rewinds`) are read from the `prune-apply`, `entry-apply` and
`forget` lines by `dev/bench/journal-fidelity.mjs`, the same module the gate
uses, so the record and the gate cannot describe the journal differently.

A recall id reaches the journal by one of two routes, and the bench reads both.
A record that mints archives carries `publish.archives[].recallId`. An applied
entry shape or an applied revert writes no `publish` record — those modes apply
through `entry-apply`/`prune-apply` and state their ids only on the application
telemetry (`kind: "telemetry"`, `event.kind: "application"`,
`event.outcome: "applied"`, `event.recallIds`). `journalCounts` unions the
`publish` ids and those telemetry ids, deduplicated, so the recall gate does not
require a `publish` row when the telemetry carries the application, still reads
`publish` where one exists, and fails when a ledger recall id appears in
neither source.

Every run scans the evidence dir, the vanilla arm included (fifteenth audit item
1): `journal === null` is no longer a state, so a vanilla control is checked for
a racoons entry file and a ledger instead of trusting its config. A vanilla run
that carries either fails `fidelity: the vanilla arm's journal is present and
parsed`, and any `tool/result` replace it stored fails
`fidelity: the vanilla arm's tool/result replacements match the applied
removals` (the vanilla arm keeps the host pruner at the host default, so its
stored replacements must equal the host's own `compaction/prune` count). A
racoons `mock` run mounts the shipped entry, which has no sink, so the journal
rows are `not-applicable` there; `mock-replay` and the real routes must leave
both files.

The journal's applied count is also compared to the ledger's own
`application_removals` rows for intents recorded `applied` (the table is written
at prepare time, so abandoned intents are excluded), and every applied
`recall_id` must exist in the `recalls` table:
`fidelity: the journal's applied removals match the ledger's
application_removals rows` (fifteenth audit item 6).

`result.json` carries them under `mockReplay.journal` on the replay lane, and
under `journal` on every other journal-gated run (a real route; ISSUE-082):

```json
"journal": {
  "verdict": "parsed", "emitted": true, "file": "…/racoons/cremator-events.jsonl",
  "lines": 67, "byKind": { "rig-mount": 1, "mounted": 1, "capabilities": 1,
    "telemetry": 30, "at-rest": 12, "entry": 15, "publish": 2, "skip": 5 },
  "capArchives": 0, "archiveTotal": 0, "sealEpisodes": 0, "negativeFacts": 0, "recalls": 0,
  "pruneFires": 1,
  "appliedRemovals": 1, "landedEntries": 0, "appliedForgets": 0, "rewinds": 0,
  "ledger": { "readable": true, "events": { "prepared": 4, "applied": 2,
    "validation": 4 }, "applications": { "verdict": 1 }, "recallIds": [ "…" ],
    "recallParts": [ { "recallId": "…", "partIndex": 0, "sourceSha256": "…",
      "sourceByteLength": 4096, "blobSha256": "…" } ], "blobRoot": "…/blobs" }
}
```

`prune-threshold` is written once per step boundary that read the prune bar, so
`byKind['prune-threshold']` is an EVALUATION count; `pruneFires` (and
`pruneThresholds` on the non-replay lane, beside `pruneThresholdEvaluations`)
is the FIRE count: `crossed: true`, plus every line of a pre-change journal,
which has no `crossed` because lines then existed only on a fire. Filter:
`dev/dsh-rig/prune-fires.mjs`.

Counts are evidence, never a target: they state what this mount did to this
record. The gates assert AGREEMENT between artifacts — journal vs the stored
session surface, journal vs the closed ledger — so a record with no oversized
result yields `capArchives: 0` and that gate is `not-applicable` (no archive was
published; the run is still green). The ledger is read in-process, read-only; a
WAL a read-only open cannot replay is copied to temp first, so evidence bytes are
never written by the reading. The recall gate then opens the session's blob store
(`storage/sessions/<id>/blobs/sha256/<xx>/<rest>`): every published recall's
`recall_parts` blob must exist, be non-empty, and hash to both `source_sha256`
and `blob_sha256`, so an id row alone cannot pass it. The rig spawns
`inspect-ledger.mjs` instead, which verifies the same bytes through the shipped
reader.

## The evidence dir

Real run (`<arm>/`), mock-replay (`<arm>-mock-replay/`):

```text
task.txt  launch.json  patch.yml  deny-probe.txt  requests.jsonl  script.json
stdout.ndjson  stderr.log  mock.out.log  mock.err.log  result.json
sessions/<project>/session-<id>/session.v4.jsonl
storages/  home/              # mock only; a real route uses the evidence dir's sessions/ and storages/
work/                         # --dry-work only: the copy the run edits
```

`result.json` carries: arm + manifest multiset, provider, `citableAs`, `removals`
(`applied`, `exercised`, `reason`: the journal's applied-removal lanes and
whether the product removed anything at all), the
`reasoning` block (`reasoningParts`, `reasoningTurns`, `assistantTurns`,
`reasoningStreamBlocks`, `turnCoverage` and the declared `floor`), `reasoningWire`
(the wire-level reading, below), brief file and
task sha256, dsh version and launch command, patch sha256, the mount block (entry,
dist, config with `capIgnored`, wrapper, harness), work mode, env, the watchdog
command/timeout/fired flag (`polls` and `error` state whether the grant was ever
read), exit code/signal/timing, mock request counts, the
token-usage rows with `usageRows`/`assistantTurns` coverage, `BENCH-DONE` seq and
line, the deny probe, the `mockReplay` block (record, map, caps, tool results,
`fidelity`, `journal`, `consumedPrefix`, `cutByCompaction`), and `context` and `compaction` present on every provider
(byte series from `requests.jsonl` on the
mock lanes, billed-prompt-token series from the session log on a real route; a
compaction is recorded, never refused), `syntheticPressure`, the projection block,
`tree` (`{checked: true, digest}` for a live run; before/after plus the arm
multiset for `--dry-work`), `assertionSummary`, and `passed`. `requestLog` and
`session.digests` carry the sha256 of the exact bytes each one-read parse saw, so
a log that changed under a second read cannot silently disagree with the rows
stated here.

**The 2026-11-08 stop and read blocks.** `checkpoints` is present on every run:
the expected paths in the brief's order (from the brief's final explicit path
list, `--deliverables`, or the default thirteen), `expected` (that list's
length), `source`, `created`, `largestReached` and `largestCommonK` (this
arm's largest reached k; a pair recomputes the common k). A completed run that
declared `BENCH-DONE` also carries the `task: the run wrote all N …` gate, with
N the derived count; a missing expected file fails it. `askLane` is the
journal's ask-lane spend (`askTokens`, `exchanges`, `pruneTablesUnmeasured`,
`known`), present on a run that carries a journal and `null` otherwise; it is
folded into the grant's TRUE total as two of its four streams. A stopped run
also carries `stoppedBy` and a `stop` block (`censored: true`, the checkpoint/limit, `benchDone.found`,
`deliverablesCreated`, `peak`, `compaction.atRequests`, `journalTotals`,
`askLane`): `passed` is false, `citableAs` says `none (censored partial at k=N;
benchDone.found=…)`, and **claims are gated on `stop.benchDone.found`, never on
`passed`**. `webTools`/`readBoundary` record the `--deny-web`/`--workspace-only`
intent when those flags are given.

**`citableAs` is a three-source claim.** `measurement (reasoning measured)` is
allowed only when the session log carries reasoning **content parts**, the
session log carries reasoning **stream blocks**, and at least one measured main
request body carries `reasoning_content` (`reasoningWire: "measured"`). A
session with parts but no stream entry is `none (reasoning transcript
incomplete)`. A run whose bodies were captured and carry no `reasoning_content`
is `none (no reasoning on the wire)` and its wire row fails.

**The stream shapes are read in both forms the log writes.** A reasoning stream
block counts from the flat entry `{"blockType":"reasoning"}` (the offline
fixtures) and from the official route's nested entry
`{"type":"chunk","time":…,"chunk":{"type":"block-start","index":0,"blockType":"reasoning"}}`
(the 2026-11-07 `effort-1024` smoke log). A content part is read from
`data.message.content` on an `assistant/message` row, falling back to
`data.content`. A `block-end`
(`{"type":"chunk","chunk":{"type":"block-end","index":0,"block":{"type":"reasoning","text":"…"}}}`)
and the finish entry's `chunk.replayState.blocks[]` repeat the block the
`block-start` already declared, so neither counts again: one block reads as one
`reasoningStreamBlocks`. A start followed by deltas on the same index also
counts once.

The two mock lanes are not measurements. `mock` is the smoke proof
(`none (mock harness proof, not a measurement)`); `mock-replay` is the offline
harness-parity lane (`none (mock replay)`, ISSUE-023). On `mock-replay` the
reasoning row and the wire row are `not-applicable` — the replay emits no
reasoning on the wire — so a Step 1b/1c run can be green without a reasoning
claim, and its `citableAs` never reads as a measurement.

`--allow-zero-reasoning` is the void flag: the reasoning row is class `void`,
`reasoning.void` is true, and the row contributes nothing to the measured count.

**`citableAs` also carries the removal qualifier.** A measurement label stays
exactly as above only when the journal records at least one applied removal. A
run that applied none — a control, or a live arm whose mount never spliced
anything — is `measurement (product effect only; no removal measured)`, so a
zero-removal live run cannot be read as a removal measurement. The same count is
`result.json.removals.applied`, the `removals=` clause on the PASS line, and the
`removals applied=…` report line; `reason` says why it is zero.

`reasoningWire` is the wire-level reading: `"measured"` names the first main
request that carried `reasoning_content` and the sha256 of that string;
`"absent"` means bodies were captured and none carried it (the row fails);
`"unmeasured"` means **no request body was captured at all** — the real route
without a capture log. `unmeasured` is not a pass and not a wire claim: it says
this run read the session log only, so `citableAs` is
`measurement (product effect only; reasoning wire unmeasured)` and the run may
not state that reasoning was measured on the wire. The reading is a request-body
reading (the mock's `requests.jsonl`), never network capture: no HTTP framing,
attempt number or send is established by it.

**Every assertion row carries `class` and `contributesToPassed`.** `measured`
means the row's subject was present and the row could fail: either a comparison
of two artifacts (the brief against its manifest, the session log against the
wire log), or a rule over one artifact whose population was non-empty (no
endpoint field in a request record names loopback; every composed
`tool-result-pruner` row a racoons run carries is disabled). `vacuous` means the population it read
was empty (no recall published, no table ask sent on either arm, no endpoint
field read, no scripted tool failure, no compaction fired); `not-applicable`
means the row does not apply to this run or its subject was absent (no archive
published, no compaction request, no request log, no usage row, no
request-shaped record, a skipped deny probe);
`void` means `--allow-zero-reasoning` let a refused reasoning comparison through;
`stopped-expected` means a `--stop-on-compaction` kill the run asked for. Only
`measured` + `ok` contributes to the PASS count. `assertionSummary` states the
six totals and the PASS line prints the measured, vacuous and not-applicable
counts beside `citableAs`, plus the void count when one exists, the applied
removal count (`removals=0` is a stated fact, never an omission) and the native
compaction count (`compacted=<n>`, judged on every provider).

`launch.json` is the launcher's OWN invocation (ISSUE-091): `schema`, the full
script path, the cwd, and `argv` exactly as `process.argv.slice(2)` held it.
`result.json.dsh.launchCommand` is the CHILD's; this is what answers a DoD box
that wants a flag "recorded verbatim". argv only, never the environment.

## Decisions (PM, 2026-10-22 and later)

1. **The bench has its own launcher** (`bench-run.mjs`). `dev/dsh-rig/run.mjs`
   is untouched: it chowns `cwd` to `<evidence>/work`, and the bench needs the
   arm itself as the working directory.
2. **One kill box, 90 minutes per arm**, for both real runs, both arms. A box
   that fires on one arm only invalidates the pairing.
   **Extended-round exception (ISSUE-078):** the extended workload runs a
   240-minute box, `--kill-ms 14400000`, on both arms alike; the 90-minute
   default above still governs every round whose task list is the short brief.
3. **The template sibling is frozen** beside the arms by `prep.mjs --sibling`
   and hashed into both manifests.
4. **Both real runs happen the same night**, one arm after the other, same
   machine, same model route.
5. **dsh-bot is out of scope** (owner ruling 2026-10-22). Evidence goes under
   this repo's `scratchpad/`, never to dsh-bot, never into a new Desktop folder.
6. **The two prompts necessarily diverge** after the mount appends its first
   negative fact. That is the treatment; the reviewer must not score it as an
   arm changing the brief.
7. **Token accounting.** No cap is set (context stress is the point);
   `result.json` publishes input/output/total from the usage rows.
8. **`BENCH-DONE` recognition** is textual; a fenced occurrence still counts.
   `--require-done` turns it into an assertion.
9. **The mount entry is parameterized; both gated routes use the wrapper.** A
   racoons run on `mock-replay` or a real route mounts `dev/dsh-rig/rig-plugin.mjs`
   for the journal and ledger; `mock` mounts the shipped entry. `--plugin-entry`
   overrides both, which is the no-sink perturbation.

## Skills and rules this mode leans on

- `docs/guides/law-verification-non-vacuity.md` — every fidelity assertion has a
  named perturbation (the runbook's table); the pressure gate adds one more.
- `docs/guides/law-restoring-exact-bytes.md` — restore with `git cat-file -p <blob>`.
- `subagent-deny.md`, `reviewer-rubric.md`, `rules-inventory.md` — the deny rows,
  the blind-review rubric, and the rule census the rubric scores.

## The opencode bench

`dev/bench/opencode-run.mjs` measures the installed opencode 2.4.0 binary against
`opencode-mock-model.mjs` (loopback, dummy bearer, no paid route). `runBench` is
the same assertion assembly without a host; `dev/bench/opencode-run.test.mjs`
drives its good case, a missing-restore case, the three stated recall-id forms
against a canonical ledger id (a malformed argument names no archive) and the
audit regressions, and runs in `npm test`.

`--ask-grammar jsonl-20-nokeepall` mounts the bench-only ask: one
`session.generate` at a depth crossing, off by default, with its tokens under
`spend.ask`. The prompt is the product table: `forgetall` and `keeplines` only.
A `forgetall` applies one prune-document removal through the core prune path, a
partial `keeplines` applies by re-emitting the kept lines inside the typed
result part, a whole-range `keeplines` with `forgotten` `None` keeps and re-tables
the unit at a later crossing, and a literal `keepall` is the terminal
`action-not-in-grammar` refusal (ADR-0053 and ADR-0054 §Amendments 2026-11-23).
The first ask states the 70 percent share line, every later ask the 40 percent
one. The product shape
requires `--prune-threshold-tokens` and `--context-window-tokens`; the
bench-only per-revision cadence is the explicit `--ask-every-revision` opt-in.
The split is exact on the loopback mock and best-effort on the real route, where
a host `step_finish` row may include the generate step and cannot be split by
kind; `grantBasis` names the conservative direction (ADR-0053).

Perturbations the shipped records catch (each names its check):

| Perturbation | Expected record |
| --- | --- |
| a removed unit's result carried again after its receipt | `removal-lane-<name>: every requested body has the unit absent…` fails |
| a re-keyed removed result that keeps the file bytes | `…exactly one result with the file sentinel` fails (or the content marker is still present) |
| no `necromancy` turn, or a restore result that is not the blob | `removals: a necromancy restore returns the removed unit's bytes, or the host's saved-output pointer hashes to them` fails; `removals.measured` false; claim `removal (no restore proven)` |
| one whole restore and one host-cut pointer | the restore lane passes and names the shape; claim `removal (restore whole for 1/2 restorable of 2 recall ids (live 2, seeded 0; excluded 0); pointer-only 1)`; `removals.restore.allWhole` false, `pointerOnly` non-empty |
| a seeded removal with no captured before-body | excluded from the restore claim as `seeded-not-restore-proven`; `restore.exclusionReasons` names the recall, label and why, and the detail carries the same sentence. A run whose recalls are all seeded with no before-body is citable only as `removal (marker only; restore not proven for k seeded)` — never bare `removal` (audit 15) |
| a seeded removal with a captured before-body | the before-body is the unit's tool result in the last request before its first receipt-bearing absence; the restore's archived `result.value` must equal it byte for byte, and a whole restore is counted in `wholeCount`/`seededRestoredRecallIds`, not excluded. The claim is `removal (restore whole for k/n restorable of r recall ids (live l, seeded s; excluded e))`; a seeded removal with a before-body but no restore, or with different returned bytes, fails by name |
| a `necromancy` argument that drops `recall:`/`sha256:`, or a malformed one | the three accepted spellings (`recall:sha256:<hex>`, `sha256:<hex>`, bare 64 lowercase hex) are credited to the ledger's canonical id; uppercase hex, a wrong prefix or a wrong length names no archive and the recall with no valid restore fails by name |
| a seeded read of a claimed lane's unit file, superseded by the first live read | the lane's sentinel count is its byte-level check: the recall is `removalCheck: "call-id-and-lane-sentinel"` and leaves `uncovered`; without that coverage the shared twin marker leaves it `call-id only` and `removals.measured` false |
| a real route whose every recall is seeded and has no captured before-body | the restorable set is empty, `restore.status` is `not-applicable`, the restore assertion is recorded `not-applicable` (a void row, never a green measured row) and the claim is `removal (marker only; restore not exercised)`, never bare `removal` (audit 18, audit 19) |
| a host that rewrites `session_v2.model` | the column is named in `hostRewrites: ["session_v2.model"]`, excluded from the seeded-row hash and recorded in the table's `excludedColumns`; the unmodified check still fails on any other seeded row change, including a message body |
| a real route whose replies carry reasoning intermittently | each reply without reasoning is counted in `repliesWithoutReasoning` and in `replyFrames.unanswered`, and does not fail; every reasoning string that did appear must still appear in later requests, or the set check fails by name. A `removal` or `control (…)` citation is citable when the context carried reasoning at all (`reasoningPresence.present`: a seed part or one answered reply frame), with the count disclosed; a `reasoning` citation requires `replyFrames.allAnswered` and is refused when any observable reply carried none (ADR-0045, amended 2026-11-07) |
| a ledger that stores a different unit under a self-consistent hash | `removals: every recall whose unit was captured in a request body…` fails; the candidate names the archived result value's sha256 and the captured result's sha256 |
| a real route whose part `source_sha256` is not the stored blob | the candidate fails by name (`stored blob file hashes to … not the recall part's source_sha256`) |
| a real route whose removed result returns under a new call id, or loses its receipt, or is still in the last request | the candidate fails by name: `came back under new call id(s)`, `no later main request carried a receipt`, `still present in the last captured main request` |
| a real route whose unit reappears after its first receipt (2/3/4/5) | the candidate fails by name (`came back on request(s) 4`); the before-body stays the last present **before** the first receipt |
| a real route whose removed text an assistant or user message carries | the candidate fails by name (`still carried by request(s) …, the absence scan reads every string of every message`) |
| a real route whose twin is a new read of the same file in the request that first omits the unit | the candidate passes; the new call id is a twin, not the removed bytes returning. A result that already carried those bytes before the removal, a new id with no same-file read declaration, or a declaration whose only path-like argument is `command`/`pattern`, still fails. |
| a real route whose removed short result sits inside a receipt's target or label | the receipt allowance is marker-aware: the unit's call id, its twins' call ids and the unit's exact result text are passed, so the line is scanned and the candidate fails by name instead of the line being excluded whole (audit 18) |
| a real route's two-part recall with the second unit still present | the candidate fails by name; every `recall_parts` call id is its own unit, absent from every request after the first receipt and archived against its own captured text |
| a core `dist/` older than core `src/` | the run refuses (`the @cremator/core build is not fresh`); a core with no `src/` is `coreBuildFresh: "unverified"` and a citation is refused |
| a live real route with no `--token-grant` | exit 2 (`a live real route requires --token-grant <n>`); the grant is polled from the captured bodies and a crossing kills the tree, `spend.fired` true |
| a `--capture-log` replay whose first body carries seeded history | the first primary body is the source: its strings seed request 1 and its reasoning is the sendable bound; `--replay-capture` forces it when the shape heuristic would call it fresh. No independent seed record exists on this route, so the two request-1 equality checks are recorded `self-consistency:` with `contributesToPassed: false` and do not count toward `passed` |
| a hook capture's `scriptAccounting` | `pass: null`, `skipped: true`, `detail` says the loopback mock is not the subject |
| a real route with a recalled unit that never reached a captured request body | the recall is recorded `removals.outside`; `removals.generic.candidateCount` is 0 for it, and because it names a tool call id with no captured body the run is not measured and not citable (`removals: every recall that names a tool part has a byte-level captured-body check` fails) |
| a real route's mixed recall (a tool unit plus a text or reasoning part) | the tool part is checked part by part; the non-tool part is recorded as `nonToolPart` and excluded from the byte claim (`byteClaim.excludesNonToolParts: true`); the run can be citable with that exclusion stated |
| a real route's multi-part recall with one tool part missing from the captured request bodies | the candidate's `outsideCallIds` is non-empty, `removals.measured` is false and the run is not citable |
| a test-arm removal claim with no control measured in this run | `citableScope.control` records `{ measured: false, paired: false, pairing: "procedural", bound: false }` and the claim is `removal (control procedural, not bound)`, whatever its restore shape, which is not citable. Pass `--control-evidence <vanilla result.json>` to bind it: the file must record this runner's `schema`, a non-empty `runId`, `arm: "vanilla"`, `passed: true`, `citable: true`, `citableAs` a `control (…)` claim, `claim.control.laneControls` with every unit and twin `pass`, `plugin.mounted === false`, `ledger.exists === false`, and its `capture.jsonl`, `stdout.ndjson` and `session.v4.jsonl` siblings must hash (path, sha256 and bytes) to what `artifacts` records; `removals.applied` is a strict check only when an available journal measured it (otherwise `not-measured`), and the same `replayDbSha256`, `modelId`, `providerId`, `capturePluginSha256`, `hostBinarySha256`, `fixtureSha256`, `workspaceSha256`, `scriptSha256`, `sessionId` and `hostVersion` (no field may be null on either side; `workspaceSha256` is the `--workspace` SOURCE digest or the sentinel `"none"`). A mismatch fails by check name (`schema`, `run-id`, `artifact-capture`, `artifact-stdout`, `artifact-session`, `replay-db`, `model`, `provider`, `capture-plugin`, `host-binary`, `fixture`, `workspace`, `script`, `session`, `host-version`, `vanilla-citable`, `vanilla-claim`, `vanilla-control-lanes`, `removals-applied`, `no-mount`, `no-ledger`); a hand-written result with no artifacts fails by `artifact-*`, and an absent or `null` `plugin.mounted`/`ledger.exists` fails `no-mount`/`no-ledger` |
| a fixture `replay.db` whose sha256 differs from its manifest | the launch refuses by name before any evidence directory is created; the fixture script describes the manifest's history, not another one |
| a real route where the only `necromancy` call is seeded history (request 1) | `restoreAttempted` false, `restoreExercised` false, `restoreNotExercised` true; the claim is `removal (archived exact bytes; restore not exercised)` |
| a real route with one run-issued `necromancy` call in the last request (no later body carries its result) | `restoreAttempted` true, `restoreNotExercised` false, `restoreProven` false; `restorePending` names the call and `restoreAttempts` records it; the claim is `removal (restore attempted, not proven)`, not citable |
| a real route's restore that returns different bytes | `removals.restore.exercised` true, `pass` false, named failures; `restoreAttempted` true, `restoreProven` false, `restoreAttempts` records the call; claim `removal (restore attempted, not proven)`, not citable |
| a script whose replies key only on `main_turn` | `script: the mock consumed each scripted reply…` fails; `matched_content_key` is false |
| zero reasoning in every request | the pin and the set are `not-applicable`; the run is not citable |
| a journal with only the `mounted` line | the three emptiness checks and the five negative journal checks are `not-applicable` |
| no request carried a receipt and the journal recorded no applied step pass | the re-application pairing check (`journal: every request that carried a receipt had its own fresh applied pass`) is `not-applicable` with that reason, never a failure; a journal pass with no receipt-bearing request still fails |
| the last assistant text is the literal on its last non-empty line, not the whole text | the final-text check passes and `task.finalTextMatch` is `"last-line"`; a trailing sentence after the literal stays a failure |
| the fixture task | six ordered steps, with step 2 a *required* re-read of `big-b.log` at the same path (explicitly not a read of `big-b-twin.txt`), so every run creates the superseded unit |
| a recall with no byte-level check, or one the cross-check cannot locate (`uncovered`) | `removals: every recall has a byte-level check…` fails; `removals.measured` false |
| a ledger absent, or one main request only | `storage: the ledger database did not change…` and the consecutive-body-hash check are `not-applicable` |
| two ledger carriers under the storage root | `storage: the ledger belongs to the run's session…` fails |

`--replay-db` seeds one session into the arm world. When the source's stored
directory does not exist on this machine (the shipped
`dev/bench/fixtures/opencode/replay.db` uses `C:\RACOONS-SYNTHETIC\workspace`),
the seeded copy is pointed at `<armDir>/world/work`; `replay.seeded.relocation`
records `from`/`to`, `replay.seeded.contentRelocated` records
`{from, to, rows}` for the message/part text rewrite (every string value that
named the synthetic root now names the world; a tool call's stored
`input.path` is part of that text), and
`replay.seeded.hostLaunchPreflight` records the four location rows. A stored
path that exists is not relocated, text included — unless `--workspace` is
set, whose rule is stated below. `replay.seeded.relocation` also carries the
`rule` (`missing` or `always`) and `alreadyAtTarget` (the source already named
the target, so no row or text was rewritten).

The fixture's unit result is the **installed host's read rendering** of
`big-b.log`, not the file's raw text: `Read file <path>, lines 1-300`, then one
`<n>: <line>` per line, no trailing newline. `opencode-fixture-build.mjs`
builds it with `hostReadText` from the same bytes `fixtureFileBytes` writes, so
a live re-read of the file is byte-identical and the product's exact-byte
`superseded-read` proof holds. The seeded tool calls name `path` (the 2.4.0
tool schema), and `nativeWorkScript` rewrites the rendered `{{WORK}}` root from
`renderScript`'s forward slashes to the world directory's native spelling, so
the seeded call key, the live call key and the read-result header name one path
on Windows.

The fixture produces **two restorable recalls**: the seeded read of `big-b.log`
and the script's own first read of the same file. The task asks for one
`necromancy` call per `[not retained]` receipt in context, and the restore reply
issues both — `RACOONS-SYNTHETIC-CALL-0005` (the seeded read) and
`call_fixture_big_b_1_…` (the scripted read). The restore lane credits both
against the ledger's canonical id: the product's grammar accepts
`recall:sha256:<hex>`, `sha256:<hex>` and bare 64 lowercase hex, and anything
else names no archive. One call restores at most 1 of 2, and the restore claim
fails by name for the recall no call returned.

Evidence is `scratchpad/launch/<yyyy-mm-dd>-<slug>/<arm>/`; never a new Desktop
folder, never committed. The result's `removals.byteDelta` is an estimate from
captured fragments: `estimatedRemovedBytes` is the unit's call entry plus tool
message, and `estimatedNetFreedBytes` subtracts the receipt line and its message
wrapper. Neither is a body-to-body delta.

### The frozen workspace (`--workspace`)

`--workspace <source>` runs the task in a writable copy of a frozen repo
instead of the synthetic fixture world. The live rerun's source is the task
repo `C:\Users\TZhen\Desktop\racoons-bench\2026-10-23-aetherium\racoons-arm`
(`C:\Users\TZ\Desktop\racoons-bench\2026-10-23-aetherium\racoons-arm` on the
other device; both forms, because the owner works from two machines): 1,787
files, 21,079,823 bytes, digest `9087422d…`. The campaign parent (8,099 files,
both arms and the template) is not a valid source: it is not one repo.

The flag is refused unless the source exists, is **absolute**, is a directory,
is outside this repo's `scratchpad/`, is not inside this repo (and does not
contain it), and does not overlap the evidence root, the arm dir or the arm
world in either direction (inside or containing). `--workspace` is allowed
with `--dry-run`: the config is composed and validated, the source digest is
recorded, and the record says `dryRun: true, launched: false`; no copy is
staged and nothing is spawned. It is refused with `--capture-log`, which
launches no host and would read no workspace.

**Source writes are detected after the run; the agent works in a staged copy.** Each arm
stages its own copy at `<evidence>/<arm>/world/work` (`workspace.path`). The
copy is:

- the **child's cwd** (`launch.command.cwd` and `workspace.cwd`), so relative
  task paths resolve there and a fresh run's own session row names it;
- the rendered `{{WORK}}` root of the mock script, so scripted reads name copy
  files, not the arm world;
- the **seeded session's directory** on `--replay-db`: `seedSessionDb` is
  called with `relocateTo: <copy>` and `relocateWhen: 'always'`, so a stored
  directory that exists but names another tree is relocated (directory columns
  and message text). A stored path that already is the copy is left byte for
  byte: `replay.seeded.relocation.alreadyAtTarget` is true; without
  `--workspace` the old rule stands (`relocateWhen: 'missing'`).

The copy also carries a minimal `.git` marker (`HEAD`, `config`, empty
`objects/` and `refs/heads/`). The evidence root is under this repo's
`scratchpad/`, so without a marker 2.4.0's git discovery climbs to this repo and
writes `project`/`worktree` rows naming the bench's own source. The marker is
harness scaffolding, not source content: `workspaceSourceDigest` excludes
`.git`, and `workspaceTreeChanges` leaves it out of the deliverable diff.

**No `worktree.directory`.** 2.4.0's `Config.Worktree.directory` is the parent
for NEW worktrees, not the project root ("Parent directory for new worktrees,
relative to the project's primary checkout when not absolute"). Naming the copy
there would ask the host to create a worktree under it instead of treating it
as the project. The composed config carries no `worktree` key; the cwd and the
session/project rows are the load-bearing statements, and both are the copy.

**The source digest is the guard.** `workspace.sourceDigest` is the
`prep.mjs`/`bench-run.mjs` multiset digest: sha256 over sorted
`<sha256>  <relative path>` lines joined with LF (no trailing newline), one
line per regular file, excluding the top-level `manifest.json` and the
defensive directory list (`.git`, `node_modules`, `dist`, `build`, …). Two
entry types the old walk skipped are now **visible**: a symlink is one line
hashed over its link text, and any other non-regular entry is one line hashed
over its relative path; `digest.symlinks` and `digest.other` count them, and a
source carrying either is refused — the manifest multiset is a regular-file
construction, so its digest cannot be compared with a tree that is not one.
Empty directories cannot be hashed by a file multiset; `digest.emptyDirectories`
records their relative paths beside the value (a directory that contributes no
line, including one holding only excluded directories), so an empty-directory
rename is visible in the record even though the file multiset's sha256 does not
move. The after-run source comparison includes that list. The digest is compared with
`<source>/manifest.json`'s `totals.multisetSha256`, `totals.files` and
`totals.bytes`, and with `--workspace-digest <sha256>` when given; a mismatch is
refused before the copy exists (`workspace.sourceExpectation` records each
check). The source is re-read after the host exits;
`workspace.sourceUnchanged` is the comparison, and a changed source fails the
run by name with `refused: {code: "workspace-source-modified"}`. That after-run
comparison is what **detects** a source write; nothing prevents one.

**The copy is writable, and its changes are the deliverables.** A task that
writes its records changes the copy by design, so `workspace.digest` and
`workspace.after` are recorded and `workspace.modified` says whether they
differ; neither fails the run. `workspaceDigest` and `workspaceTree` include a
line/entry per directory, so an empty directory the task creates (or deletes)
moves the digest and appears in `changes.directoryChanges`; `workspace.changes`
names the created, modified and deleted paths, and `workspace.deliverables`
lists the absolute paths of the created/modified files and symlinks (the `.git`
marker is excluded, directories are not deliverables). A script whose
`fixture` block declares files is still validated, but on this path the block is
not written anywhere: `workspace.fixtureSkipped` says a declared block was
skipped, `fixture` is null in the result, and no fixture lane is measured.

**The write boundary — detection, not prevention.** 2.4.0 has no path sandbox;
the host writes before this bench reads the captured bodies. `workspace.writeBoundary`
classifies every captured `write`/`edit`/`create` call's `path`/`filePath`/
`file_path`/`notebook_path` after resolution against the copy: a relative path
resolves against the copy; a `..` that leaves it is `kind: "escape"`; an
absolute path outside is `"deny-root"` when it lands in the source, the evidence
root or this repo, otherwise `"absolute-outside"`; a path inside the copy whose
real target leaves it is `"symlink-escape"`. No `--allow-read` root is writable.
A violation fails the run as `refused: {code: "workspace-write-escape"}` (escape
or symlink row) or `workspace-write-outside`, and the refusal and
`writeBoundary.detection` both say the write was detected **after** the run, not
prevented. The source digest above is the separate guard that the frozen tree is
unchanged; a write that leaves the copy but not the source is still a failed
run.

**The read boundary.** 2.4.0 composes a permission list, not a path sandbox,
and this bench does not invent one: the only host permission it writes is the
`subagent` deny (plus the shell denies below on a workspace run).
`workspace.readPolicy` records that no rule removes the
`read` tool. What the bench can check is what the captured tool calls named:
`workspace.readBoundary` classifies every `path`/`filePath`/`file_path`/`cwd`/
`cd`/`notebook_path` value and every absolute path token in a `command` after
resolution. Write/edit/create calls are excluded here — they are the write
boundary's subject, so one path is not counted twice. The allowed roots are the
copy and every repeated `--allow-read <dir>` (the sibling template, read-only).
A relative path is resolved against the copy (the session directory) and counted
**inside** when it lands there. Three shapes are **violations**:

- a `..` that leaves every allowed root (`kind: "escape"`; a `..` that stays
  inside, like `sub/../a.txt`, is allowed);
- an absolute path outside every allowed root (`kind: "absolute-outside"`, or
  `"deny-root"` when it lands in the evidence root or this repo);
- an allowed path whose real target — after following symlinks and Windows
  junctions — leaves every allowed root (`kind: "symlink-escape"`).

A violation fails the run by name: `refused: {code: "workspace-read-escape"}`
for an escape or symlink row, `refused: {code: "workspace-read-outside"}`
otherwise. `readBoundary.outsideCount` counts the rows that resolved outside
every allowed root (the old field was always `0` because nothing was ever put in
its bucket); `violationCount` can be larger when a `shell-disabled` or
`unresolvable` row is also present. The limits are `read-boundary.mjs`'s: a path
built at runtime from shell variables, or `cd` followed by a relative read, is
invisible to this scan.

**`--allow-read` is validated as a narrow root.** It must be absolute, exist, be
a directory, and then: not a drive/filesystem root (`C:/`, `/`), not this repo
and not a path containing it, not the evidence root / arm / world (nor containing
one), and not the `--workspace` source or the staged copy in either direction.
The root is canonicalized with `realpath` before those checks, so a
junction/symlink is judged by the tree it resolves to (a link named outside the
repo that resolves into it is refused); the recorded root is the canonical
target. A root that contains the source — the campaign parent, the Desktop — is
refused, because the source is the frozen tree the digest guards. The sibling
template (`.../2026-10-23-aetherium/miliastra-game-template`) is the intended
shape: outside the repo, outside the evidence root, and not containing the
source.

**The shell (`shell`/`bash`/`execute`) is denied on a workspace run.** The
extended brief was read before choosing: pass 5 says "Run them by whatever means
your tools give you" and explicitly offers "reproduce the same filter by reading
and counting instead", so a shell is not required. The composed config adds
`*`-deny rules for `shell` (the name installed 2.4.0 exposes), `bash` and
`execute` beside the subagent deny (`workspaceReadPolicy` records them as
`shellDisableRules`), `workspace.shell` records the policy and the brief basis,
and every captured tool list is checked for the names. A shell call that appears
anyway is a `shell-disabled` violation and fails the run: its `cd`, `type`, `dir`
and redirection writes are outside the path scans.

**The task file.** `--task-file <path>` reads the task from a brief instead of
argv: the first fenced block under `## Task text` (trimmed), exactly as
`bench-run.mjs` reads it; a file with no such heading is the task whole. The
sha256 is over the extracted text, not the file bytes, so it compares with a
round manifest's `brief.taskSha256`. The 4,000-character argv guard is raised
to 30,000 for this channel; the extended brief's block is 9,329 chars / sha256
`4d2d3fbe…`. `result.task` records the text, sha256, chars, source
(`task-file`), and the file record (path, extraction rule, fence line).

Both arms share one source, one script, one task, one model and one permission
list; each stages its own equal copy and records its own copy digest, while
the control subject binds the shared **source** digest
(`workspaceSha256`). `dev/bench/opencode-run.test.mjs` covers the flag and its
refusals, config composition (no `worktree` key, the permission list), source
digest/manifest matching, staging and the writable copy, the read and write
classifiers (relative, `..`, absolute outside, sibling, junction), the
`--allow-read` refusals, the shell deny, the spend meter, the capture-loader
preflight, task-file extraction, and run-level mock runs (cwd/session directory,
deliverables, fixture skip, escape refusals); `opencode-real-route.test.mjs`
covers the allowed `--dry-run`, the refused `--allow-read` roots and the
9,329-char brief.

The checkpoint reader is a separate offline tool:
`node dev/bench/opencode-checkpoints.mjs <stdout.ndjson> [<result.json>]
[--deliverables <file>] [--json]`. It names the thirteen deliverables by exact
path (no `01-*` prefixes), reports billed prompt, fill, running total, peak and
compaction timing per checkpoint, and states the host compaction position as
`compactionPosition.atMainRequests` (primary-request index: main and compaction
rows only) while keeping `atRequests` as the capture sequence (every captured
row, ask and title included). It does
not print an overhead token row: on a `host-step-tokens` basis the runner's
`spend.billedPromptTokens` is the sum of the same `step_finish` rows the reader
sums, so `overall.stepTotalDifferenceTokens` is 0 and a nonzero value is
reported as a reader mismatch, never as title/tool-less/compaction tokens.
Under any other basis `result.spend.billedPromptTokens` is a bytes/3 capture
estimate: it is reported as `captureEstimate` and nothing is subtracted. Shell
rows are counted and never read as deliverable writes.

A mock run is offline plumbing: its reasoning is scripted, so it is never
citable as `reasoning` (see *A mock run is offline plumbing* above).

### The real route and the `http.request` observer

`opencode-run.mjs` mounts `opencode-capture-plugin.mjs` on a real route. The
plugin registers `session.hook("http.request")`, clones the request (never
mutates it), and writes one JSONL line per event to `<armDir>/capture.jsonl`.
The host imports a generated plugin **directory**, `<armDir>/capture/plugin/`:
2.4.0's loader refuses a file target (`configured plugin path must be a
directory`) and resolves a local directory through its `package.json`. The
directory holds `package.json`
(`{name: "cremator-opencode-capture", private, type: "module", main:
"./index.mjs", exports: {"./server": "./index.mjs", ".": "./index.mjs"}}`; the
host probes `./server` first) and `index.mjs`, the generated
adapter that wraps the plugin factory in the 2.4.0 `{ id, setup }` shape and
writes the plugin's `captureSummary()` to `<capture.jsonl>.summary.json`. The
plugin itself also rewrites that sidecar on **every flush** (the 1 s timer, the
exit flush and `captureFlush`) and once at setup, so a host that dies without
running an exit handler still leaves a summary as new as its last line. The
reader trusts a summary only when its mtime is at least the log's; an older
sidecar is `summaryFresh: false` and treated as absent. The composed config's
`plugins[].package` is the directory file URL, never the entry file. Both arms
may mount it; the mock route's config is unchanged and keeps
`mock/requests.jsonl`.

**A mock run is offline plumbing, not a reasoning measurement.** On
`--provider mock` every reply, including its reasoning, is scripted by
`opencode-mock-model.mjs`; the capture proves the loopback plumbing delivered
the script, not that an agent produced reasoning. `citableClaim` therefore
returns `none (offline mock plumbing; reasoning is scripted by the mock, not
produced by an agent)` whenever a mock run would otherwise be labelled
`reasoning`. A mock run can still be cited for a measured removal or a control
claim, which have their own wire evidence; it can never be cited as reasoning.

**The binding hash is the static plugin module, not the adapter.** The
generated `index.mjs` embeds this arm's `capture.jsonl` and summary paths, so
its own hash differs between a test arm and its vanilla control by evidence
directory alone (run21: expected `fbc65ce5…`, actual `8a1488e5…`). The control's
`capturePluginSha256` is therefore the sha256 of
`dev/bench/opencode-capture-plugin.mjs`'s bytes; `capture.plugin.sha256` records
it, `capture.plugin.hashed` names that file and `["bytes"]`, and
`capture.plugin.loader.sha256` keeps the adapter's own hash for provenance
only.

What a line holds: `seq`, `at`, `sessionID`, `agent`, `model`, `kind`,
`method`, `url`, headers (`authorization`/`cookie` as `{ present }` only),
`bodyBytes`, `bodySha256`, `body`, `bodyRecordedBytes`, `truncated`. A request
with no body (`GET /models`) carries `bodyless: true`, `bodyReadable: false`,
`bodyBytes: 0`, `bodySha256: null` and no `bodyError`; it keeps its line and its
`kind` count and is skipped by every body check. `kind` is
`primary | compaction | title | generate`. `readCaptureLog` maps `primary` to a
main turn and keeps the others separate; `captureCounts` records all five
counts, and the assertion `capture: title, compaction and generate lines are not
counted as main turns` fails if the map is not one-to-one. Title and compaction
are derived from the **body's own prompt** (`title_prompt`, `compaction_prompt`),
not from `kind`: a `primary` line whose body carries the title prompt, or a
`title` line whose body does not, fails by name. A body-bearing line with no
`bodySha256` is a capture error; the hash is how a later check says the recorded
body is the bytes the plugin read.

New result fields:

| Field | Meaning |
| --- | --- |
| `schema` / `runId` | `cremator-opencode-bench/1` and a non-empty per-process id (`<arm>-<yyyyMMddHHmmss>-<random>`); the control binding requires both (audit 21) |
| `artifacts` | `{ capture, stdout, session, checks }`: each artifact records `{ path, exists, bytes, sha256, source }`, and `checks` has one `{ name, pass, sha256, bytes }` row per artifact. The files are `<armDir>/capture.jsonl`, `<armDir>/stdout.ndjson` and `<armDir>/session.v4.jsonl`; the session file is a JSONL export of the arm-world host database's `session_message` rows (a header line names the session and source), written even when the database is absent so the artifact exists and its header names the reason |
| `capture.source` / `capture.kind` | `http-request-hook` on a real route; `loopback-mock-jsonl` on the mock |
| `capture.path` | `<armDir>/capture.jsonl` |
| `capture.plugin` | `{ id, directory, module, sha256, hashed: { file, fields }, loader: { path, sha256 }, packageJson, packageSha256, logPath, summaryPath }`. **`sha256` is the binding hash**: the sha256 of the static observer module `dev/bench/opencode-capture-plugin.mjs` (`hashed.file` is that path and `hashed.fields` is `["bytes"]`), so two arms whose only difference is their evidence/log path share it. `loader.sha256` is the generated per-arm adapter's own hash (it embeds `capture.jsonl` and its summary path) and is provenance only; it never binds a control |
| `capture.summary` | `lines`, `errors`, `truncated`, `dropped`, `droppedKnown`, `pending`, `incomplete`, `summaryFresh`, `completeness`, `records`, `bytes` (the sidecar's counters plus the file's own read); `summaryFresh` is false when the sidecar predates the log's last write |
| `capture.counts` | `primary`, `title`, `compaction`, `generate`, `other` |
| `capture.blocked` | true when `errors > 0`, `truncated > 0`, `dropped > 0`, `droppedKnown` is false (no summary, or a summary older than the last line), or the sidecar's `lines` is not the file's line count plus `pending` (a body read still in flight at exit); `citable` is then false and `citableBlockedBy` names the capture |
| `capture.doesNotProve` | `send`, `httpFraming`, `retries`, `modelCalls`: each is not established by a hook line |
| `requests.captureKinds` | the raw `SessionRequestKind` of every line, before the main-turn mapping |
| `removals.generic` | the real route's removal verdict: candidate recalls (each `recall_parts` tool call id is its own unit that carried a tool result in a captured request; a non-tool part is recorded as `nonToolPart` and excluded from `byteClaim`), each unit's before-request, the requests after the first receipt that carried it again, each unit's `archive` (stored blob hashes and the archived result compared with the captured result text), `outsideCallIds` (a named failure), `outsideToolParts`, the blob verdict, `restoreExercised`, `restoreCalls`, `restorePending` and `restoreNote` |
| `removals.realRoute` | true when the evidence is generic (the real route) rather than a fixture lane |
| `removals.outside` | the real route's recalls whose tool parts never reached a captured request body; a recall with no tool part is recorded there as a note, a recall that names a tool call id there is an unchecked tool part and blocks `removals.measured` and a citation |
| `removals.callIdOnlyRecallIds` | on the real route: recalls whose tool part is outside the captured request bodies (`check: "tool-part-not-in-captured-body"`). Non-empty blocks `removals.measured` and a citation through `citableBlockedBy` |
| `removals.restoreNotExercised` / `removals.restoreNote` | true and the reason only when the run issued **zero** `necromancy` calls whose first appearance is after the first captured request. A run-issued call with no later body is an attempt, not an absence (`restoreAttempted`), and its reason says `not proven` |
| `removals.restoreAttempted` / `removals.restoreAttempts` | `restoreAttempted` is true when the run issued at least one `necromancy` call. `restoreAttempts` records one entry per run-issued call — `callId`, `firstSeq`, `resultSeq`, `returned`, `recallId`, `pass`, `why` — including malformed arguments, unknown recalls, calls with no later body and wrong bytes, so a failed attempt never disappears from the record |
| `removals.restoreProven` | the citation gate: true when zero run-issued calls exist (restore not exercised), or when every attempt passed and every restorable recall came back whole. False with any attempt means `removal (restore attempted, not proven)`, which is not citable |
| `removals.restore.exercised` | whether the restore lane ran: false with `pass: null` and no failures only when zero run-issued calls exist; true (with `pass: true/false`) when this run issued at least one `necromancy` call, even if no later body carried a result |
| `spend` | `{ billedPromptTokens, billedCompletionTokens, billedTokens, grant, fired, completionMetered, source, usageRows, estimatedRows, polls, bounds }`: the mock's `usage.prompt_tokens` (plus `usage.completion_tokens` when present) where a row carries it, otherwise a `body_bytes / 3` prompt estimate from the captured body. A real route adds `meterBasis` (`host-step-tokens` or `capture-estimate`), `capturedEstimatePromptTokens`, `capturedPromptTokens`, `hostPromptTokens`, `hostCompletionTokens`, `hostSteps`, `hostIncompleteSteps`: a complete host step reading is `billedPromptTokens` even when the capture estimate is larger, and only an absent or incomplete host reading falls back to the larger of the two, so an unloaded observer cannot silence the grant. `bounds` states that the grant is compared against prompt + completion tokens, that completion is counted only from the source the meter used (mock usage rows, or the host's step rows whenever they printed) and that the kill timer is the wall bound; a hook capture alone records no response, so `completionMetered` is false when no complete host step row printed, and a real route with unmetered completion fails the `spend: completion tokens were metered on the real route` check by name. A fired grant failed the run |
| `claimScope` | `"captured-request-bodies (send not proven); a request that bypassed the hook is outside this claim"`: every claim is measured on request-body clones the observer wrote before the send; it never says a request reached the provider, and a request the hook never saw is not part of the claim. Printed on the status line |
| `replyFrames` | `{ answered, unanswered, allAnswered }`, recorded on every run and on the status line. `answered + unanswered` is the observable reply set; the last reply has no later request, so it is neither. `allAnswered` is the gate a `reasoning` citation requires (ADR-0045) |
| `reasoningPresence` | `{ present, seedOnly, label, seededReasoningParts, answeredReplyFrames, unansweredReplyFrames, allAnswered, repliesWithoutReasoning }`: the gate a `removal` or `control (…)` citation requires. `present` means **at least one answered reply frame**; a seeded reasoning part alone is `seedOnly: true`, `label: "presence-seed-only"`, `present: false`, and is not citable (audit 21). The counts are the record, not a pass. On a seeded request (a replay or a seeded `--capture-log` body) a removal claim's record carries `label: "presence-from-seed (disclosure, not evidence)"` when it also has an answered frame; the seed is a disclosure, never the presence the claim rests on |
| `repliesWithoutReasoning` | the cumulative count of reply messages that carried a body and no reasoning; disclosed in the result and on the status line beside `citableAs`, never a failure |
| `claim` | `{ label, scope, control, presence }`: the citable label (or the `none`/unbound label that blocked it), its scope, the control binding and the presence record. A test-arm removal with no evidence records `control.bound: false`, `pairing: "procedural"` and `label: "removal (control procedural, not bound)"` |
| `citableScope.control` | `{ measured, paired, pairing, bound, evidence, checks, lanes, laneControls, statement }`: a control lane measured in this run is `paired: true`. A test-arm removal claim bound by `--control-evidence` records `bound: true`, `pairing: "bound"`, the evidence path and every named check; without it `bound: false`, `pairing: "procedural"` and the claim is not citable. `laneControls` names each lane's `{ unit, twin, reason }`; on the live-read control both halves are required, and only the marker fallback can record `twin: "not-exercised"` |
| `coreBuildFresh` | `fresh` (core dist at least as new as core src), `stale`, `unverified` (no `src/` to compare) or not-applicable on a vanilla arm; `unverified` blocks a citation |
| `requests.scriptAccounting` | the mock's scripted-reply accounting; on a hook capture `pass: null`, `measured: false`, `skipped: true` with the reason |
| `task.expectFinal` | the literal final text the run was asked for (`--expect-final`, default `DONE`) |
| `task.finalTextMatch` | how the last assistant text matched that literal: `"exact"` (the whole text equals it) or `"last-line"` (its last non-empty line equals it, so a model that keeps a sentence above `DONE` still passes); `null` on a mismatch, which stays a failure |
| `removals.unexercisedLanes` | mock-route fixture lanes the captured bodies never show; not measured, not failed; the real route reads no lane at all |

Checks that now run on a real route when a capture log exists: the at-least-one
primary check, the consecutive-body-hash check, the title/compaction checks, the
tool-table checks, the reasoning pin and cumulative set, the request-1 content
baseline and per-request containment, consecutive-pair stability, the **generic
removal verdict**, the blob-hash check and the restore lane when a `necromancy`
call exists. The loopback-only checks (dummy bearer, no refusal, scripted-reply
accounting) are `skipped` with a reason; they are not passed. A capture with an
error, a truncated line or a body-bearing line with no hash fails
`capture: every captured body line is whole and readable` and is not citable. A
capture with a dropped line, no exit summary or a `lines + pending` mismatch
keeps that assertion green (the lines that were written are whole) but
`captureBlocked` is true, so the run is not citable.

The real route's removal claim is generic: **every `recall_parts` tool call id is
its own unit.** Each unit's call id and **exact result text** must be absent from
every request after the recall's **first receipt** (not only after the last
request that happened to carry it), a receipt naming the recall id must be
present, the ledger's blob files must hash to their rows, and each unit's
archived value must hold that unit's captured text:
`realRouteArchiveVerdict` checks each part's `blob_sha256`/`source_sha256`
against its stored blob file and its archived `result.value` against that unit's
captured pre-removal text, so a different unit under a self-consistent hash
fails by name, and a second part that remains present fails by its own call id.
A **mixed recall** is checked part by part: its tool parts are measured, and a
non-tool part (assistant text or reasoning, with no tool call id) is recorded as
`nonToolPart` and excluded from the byte claim; the claim says so. A tool part
that never reached a captured request body is `outsideCallIds` on a candidate (or
the whole recall is in `removals.outside`), is never byte-checked, and blocks
`removals.measured` and a citation. The absence scan reads **every string of
every message**, not only tool results, with the receipt's own line checked
against the unit's and its twins' call ids and the unit's exact result text
before it is allowed through. A **new** call id carrying the removed text is a
twin only when its first declaration is at the removal (or later) and names a
read of the same file path; `command` and `pattern` are not paths. A result that
already carried those bytes before the removal is not a twin and fails by name,
and the unit's own call id is never a twin. The claim states the exception
exactly:
**the removed text reappears only under a new call id (first declared at the
removal or later) declaring a read of the same file path**. A same-path copy
under a new call id (the declared twin) is **required**: its own result must
survive in every later captured body, and a run whose unit and twin are both
absent fails by name (`no same-path re-read …`). The same words are in `removalClassLabel({ realRoute: true })`
and the real-route removal detail.
The restore counts only a `necromancy` call **this run issued**: its id must
first appear after the first captured request, and an id the source session's
`perCall` map names is in the seed. A call already in request 1 is seeded
history and credits nothing, even when it names the recall and returns bytes.
**"Restore not exercised" is only zero run-issued calls.** With none, the claim
is `removal (archived exact bytes; restore not exercised)`,
`restore.exercised` is false, `pass` is null and there is no failure.
**Every run-issued attempt for a recall must be correct**: a wrong
earlier attempt fails the recall even when a later attempt returns the right
bytes, and `restore.rows[].attempts` records each call (`recallCallId`,
`returned`, `pass`, its own byte comparisons) so the verdict names which one
failed. A run-issued call that is malformed, names an unknown recall, has no
later body carrying its result, returns wrong bytes, or restores only some of
the required recalls is **attempted, not proven**: `restoreAttempted` is true,
`restoreProven` and `removalMeasured` are false, `restoreAttempts` records the
call, and the claim is `removal (restore attempted, not proven)`, which is not
citable. **When every recall is seeded and none has a captured before-body, the
restorable set is empty: `restore.status` is `not-applicable`, the restore
assertion is a void `not-applicable` row (never a green measured row), and the
claim names what was measured — `removal (marker only; restore not exercised)` —
never a bare `removal` (audit 18, audit 19); a run-issued call beside that empty
set makes it `removal (restore attempted, not proven)` instead.** A seeded recall
whose unit result a captured body carries before the removal **is** restorable:
its archived `result.value` is compared with that captured text byte for byte,
the whole restore is counted in `wholeCount` and `seededRestoredRecallIds`, and
the claim names the shape — `removal (restore whole for k/n restorable of r
recall ids (live l, seeded s; excluded e))` — never a bare `removal`; `l` and
`s` split the restorable set, so a seeded restore is not counted as live. A seeded recall with a
before-body whose restore returns different bytes, or that has no restore at
all, fails by name. A run-issued restore that returns different bytes keeps
`pass: false` with named failures, and the claim is
`removal (restore attempted, not proven)`.

The vanilla control on a real route groups **live** tool results, not markers.
`controlLaneVerdicts(…, { realRoute: true })` reads the script's `expectedReads`
and, for each file, counts the run's live reads — call ids whose first
appearance is after the first captured main request — by the path the call
declares (`filePath`/`file_path`/`path`; a command or pattern is not a path).
The seeded read of the unit file first appears in request 1, so it is never
counted. The shipped fixture declares `{"big-b.log": {count: 2, sentinel: …},
"big-b-twin.txt": {count: 1, sentinel: …}, "hello.txt": {count: 1, sentinel: …}}`:
the second read of the unit file is **required**, and the seeded read alone
satisfies no count. Each entry's declared fixture sentinel must appear in the
read's own result text; a read whose result lacks it (ENOENT, an empty file, or
another file's bytes) does not count (audit 21). Each counted read's **own result message**
must appear, addressed to its own call id with the same strings, in every main
request after its landing; a later body that dropped or rewrote it fails by
request. The lane's `unitFiles` are the unit half and every other expected file
is the twin half; both are required, so a file the task asks for and the model
never read is a failure, not `not-exercised`. A fixture that declares no
`expectedReads` falls back to the marker-based control (the unit file's sentinel
and any content marker, each twin result's sentinel, inside each result's own
message from its landing request onward); the marker form keeps
`twin: "not-exercised"` for a twin the model never read. **The control cannot be
measured in the same invocation as the test arm**, so `citableScope.control`
records `{ measured, paired, pairing, bound, evidence, checks, lanes,
laneControls, statement }`: a test-arm removal claim is citable only when
`--control-evidence <vanilla result.json>` binds it (`bound: true`,
`pairing: "bound"`, the evidence path and every check). A declaration alone
records `bound: false`, `pairing: "procedural"`, and the claim is `removal
(control procedural, not bound)` **whatever its restore shape**: the binding is
checked before any restore-shaped label, and the citation is refused by name
(`control: a removal claim on the test arm needs a bound vanilla control`).
The binding reads the evidence's own verdict **and the run behind it**, not
only `passed`: the file must record this runner's `schema`, a non-empty `runId`,
`arm: "vanilla"`, `passed: true`, `citable: true`, `citableAs` a `control (…)`
claim, `claim.control.laneControls` with at least one lane whose unit and twin
are both `pass`, `plugin.mounted === false` and `ledger.exists === false` (a
boolean; an absent or `null` field fails by name). The result's
`capture.jsonl`, `stdout.ndjson` and `session.v4.jsonl` siblings are re-hashed
from the result's own directory (path, sha256 and bytes) and must equal what
`artifacts` records: a hand-written result with no siblings fails `artifact-*`,
and a copied result whose artifact bytes differ fails the artifact that moved.
A vanilla that passed but may not be cited binds nothing. The subject must equal
this run's on **every** field, and no field may be `null` on either side
(`null === null` is a failure): `replayDbSha256`, `modelId`, `providerId`,
`capturePluginSha256`, `hostBinarySha256`, `fixtureSha256`, `workspaceSha256`,
`scriptSha256`, `sessionId`, `hostVersion`. `workspaceSha256` is the
`--workspace` SOURCE digest on a workspace campaign and the sentinel `"none"` on the
fixture path, so two fixture arms still bind and a workspace arm can never bind
a fixture control. Each mismatch fails by its check name (`schema`,
`run-id`, `artifact-capture`, `artifact-stdout`, `artifact-session`, `replay-db`,
`model`, `provider`, `capture-plugin`, `host-binary`, `fixture`, `workspace`,
`script`, `session`, `host-version`), beside `vanilla-citable`, `vanilla-claim`,
`vanilla-control-lanes`, `arm`, `vanilla-passed`, `removals-applied`,
`no-mount` and `no-ledger`.
`removals.applied` is 0 by construction when the evidence carries no journal, so
the check is recorded `not-measured`, excluded from `strictCheckCount`, and
listed in `notMeasured`; an explicit positive count without a journal still
fails. The claim says `no applied removal measured (the record carries no
journal)` in that case, and only says `no applied removal (the journal measured
it)` when an available journal proved it. The vanilla claim states which half
held and what was measured. A vanilla arm has no journal, so its removal count
is not measured: the claim is `control (the unit and its twin survive without
the mount; no mount, no ledger, removal count not measured)` when both halves
held, and `control (the unit survives without the mount; twin not exercised; no
mount, no ledger, removal count not measured)` when the model never read the
twin file. The shorter `control (the unit and its twin survive without the
mount)` is used only when a journal exists (`journalAvailable: true`).
`--expect-final <text>` names the literal final assistant text the task asks for
(default `DONE`); the check's name carries it and `task.expectFinal` records it.
The check accepts either the whole text equal to the literal or the literal as
the last non-empty line — a live model wrote `Reads done: … DONE` and whole-text
equality failed it — and `task.finalTextMatch` records which shape matched
(`"exact"` or `"last-line"`). A trailing sentence after the literal changes the
last line, so it stays a failure with `finalTextMatch: null`.

The live launcher reads the citation gate from the reader:
`captureBlockedForRoute` returns `readCaptureLog(...).blocked`, so a capture with
`summary.incomplete: true` (the sidecar's line count is not the file's plus
`pending`) is `captureBlocked: true` on the live path as well, and the run is not
citable.

A live real route requires `--token-grant <n>`; the request log is polled while
the child runs and the tree is killed when the summed spend exceeds the grant.
The mock's rows contribute their `usage.prompt_tokens`, plus
`usage.completion_tokens` when the row carries it; a real capture contributes a
`body_bytes / 3` **prompt** estimate because the observer hooks `http.request`
and never sees a response, so completion tokens are not captured or metered
there. **A real route also meters the host's own `step_finish` tokens**: the
stdout stream carries `part.tokens = {input, output, reasoning, cache:
{read, write}}` per step, and `spendReading` bills the host's prompt total
whenever every step row is complete, even when the capture estimate is larger;
only an absent or incomplete host reading falls back to the larger total, so an
observer that never loaded cannot leave the grant silent (`spend.meterBasis`
names which reading won, `capturedEstimatePromptTokens` and `hostPromptTokens`
keep both). Before the child is spawned, `captureLoaderRefusal`
checks the generated plugin directory's `index.mjs`, `package.json` and its
`exports["./server"]`; a loader the host would not resolve is refused **before**
spend. The grant is compared against prompt + completion tokens; completion is
counted only from the source the meter used (the host's `step_finish` rows
whenever they printed; the capture alone carries none), and **the kill timer is
the wall bound**.
`result.json.spend` records the prompt and completion sums, the
grant, whether it fired, which source produced the number, and `bounds` repeats
those two facts; a fired grant fails the run. A real run whose host printed step
rows without complete token fields fails by name rather than leaving the meter
with no source. The mounted
core's freshness is checked too: core `dist/` older than core `src/` refuses the
launch, and a core with no `src/` records `coreBuildFresh: "unverified"` and
blocks a citation.

**The declared window and the reply bound.** The composed real-route model declares
`limit: {context: 400000}` and **no `output` cap**. The old 16,384 cap was an
invented number (owner ruling 2026-11-08) and is deleted, not replaced: the host /
model default applies. The installed 2.4.0 generation builder uses 32,000 when
the model declares no `output` (`min(limit.output > 0 ? limit.output : 32000,
256000)`, then capped by the remaining window on a primary turn), and that host
default is recorded as `route.modelLimit.outputDefaultTokens` in `launch.json`
and `result.json` — recorded, never written into the config. (The 8,192 fallback
in the host binary belongs to the Anthropic provider only; this route is
OpenAI-chat.) The native-compaction
ceiling is computed from the window by the installed host's formula,
`context - max(floor(context * 0.15), 16000 when context >= 32000)`, which does
**not** use the output cap: the 400,000 window gives 340,000 tokens. If a live
route ever requires an explicit output limit, that is a blocker to report, not a
number for the bench to invent.

This is a captured-request-body record, captured before send, not a record of
what the provider received: the hook fires before the send,
carries no attempt number, and records no HTTP framing. `--capture-log <path>`
replays a previous log through `runBench` with `wireOnly: true`; it launches no
host, needs no script, and records its storage/journal checks as `skipped`. A
first primary body that carries seeded history is used as the replay source (its
strings seed request 1 and its reasoning is the sendable bound);
`--replay-capture` forces that reading when the shape heuristic would call the
capture fresh. Because there is no source database and no stored seed
description, those two request-1 equality checks compare that body with facts
derived from it whenever the capture is seeded (and whenever the task itself
came from the body): they are recorded as `self-consistency:` records with
`contributesToPassed: false`, and `requestOneBaseline` says
`self-consistency`. Only a fresh capture with the task named on the command line
keeps them counted, because only then is the task independent of the body.
