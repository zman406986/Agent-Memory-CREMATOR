# Bench runbook — two arms, one brief, one wall-clock box

Binding ticket: `issue-tracker/open/ISSUE-018-*.md`; mock-replay mode:
`issue-tracker/open/ISSUE-023-*.md`. Corpus: `prep.mjs`, `bench-run.mjs`,
`mock-replay.mjs`, `mock-smoke.script.json`, `bench-brief.md`,
`subagent-deny.md`, `reviewer-rubric.md`, `rules-inventory.md`. Evidence goes
under this repo's `scratchpad/`, never to dsh-bot, never into a new Desktop
folder. Round-1 history, the projection's key list, the perturbation matrix and
the PM decisions are in `dev/bench/reference.md`; this file is what to run.

Live-run policy: `docs/adr/ADR-0058-live-test-law-withdrawn-200m-soft-cap.md` and
`docs/guides/ref-live-testing.md`. The 2026-11-08 live-test law is withdrawn; the policy cap is a
soft 200,000,000 true tokens per run, and no timer value is required.

## Current shape (2026-11-10): dsh 36/36 fresh, or 32 + 4 resumed

This is the live dsh shape. It supersedes the older paths and steps below;
those stay as history. A new run means: restage, run one arm, check the
acceptance rows, record the tree digest, repeat. Never mix this shape with a
resumed one or with an older brief.

**Arms and route.** `racoons` (product) with the host `tool-result-pruner`
disabled; `vanilla` with the host default (on), per ADR-0055. Provider
`deepseek-official`, model `deepseek-flash`, reasoning `low`. Both arms get
the same brief, the same frozen image and the same flags except the product's
prune settings.

**Inputs for the 36/36 shape and the resume:**

| What | Value |
| --- | --- |
| Full brief | `dev/bench/bench-brief-extended-36.md`, task block: 25,199 chars, sha256 `774c9b32f590902f41be3b3d75752d069953d813cc2578a9503ce230620cd6d5` (the full brief file is 34,723 chars, sha256 `efc1101cbfebc0bf9220b290aea79ab010ef1e7c213997f12cb9b856fe89864f`); records 32-34 are the ADR and plan summaries, record 35 is the pelican |
| Manifest | `dev/bench/manifests/2026-11-10-extended-36.manifest.json`, image `9087422da59c721391ce57303dbf8770ff7ccb1352a622f493366a8807329a98`, 1,787 files, 34 read sets, 1,361 reads / 16,209 KiB, 36 deliverables |
| Resume task | `dev/bench/bench-brief-extended-36-followup.md`; four new records (32-35), the 32 prior records stay |
| Launcher | `bench-run.mjs` blob `6eb49b6d`, `dsh-checkpoints.mjs` `3e531ab0`, `manifest-gate.mjs` `d0d99d2d`, `token-watchdog.mjs` `15b111ba`, `token-alarm.mjs` `37bc8ba7` |
| Dist | `scratchpad/dsh-rig/dist`, 164 files, tree `b68f5c4af1b589118a1a9f71d2bb0b32194d875a96d0342d74ea8abb71944c45`, stamp `8a10143c…` |
| Grant and box | `--token-grant 100000000` true total and `--kill-ms 14400000` (4 h) are this shape's local stops. Both sit within the ADR-0058 policy: a soft 200,000,000 true-token cap per run and no required timer value. A grant fire is `stopped-by-budget`, a censored draw, not a pass |

**Paths.** Source `C:\Users\TZhen\Desktop\Aetherium-Bastion` (other device
`C:\Users\TZ\Desktop\Aetherium-Bastion`); parked sibling
`C:\Users\TZhen\Desktop\racoons-bench\_sibling-parked-2026-10-27` (other device
`C:\Users\TZ\…`); bench root `C:\Users\TZhen\Desktop\racoons-bench\2026-10-23-aetherium`
(other device `C:\Users\TZ\…`); this repo `C:\Users\TZhen\Desktop\racoons`
(other device `C:\Users\TZ\Desktop\racoons`). Credentials stay at
`C:\Users\TZhen\.dsh\.credentials.yaml` (other device `C:\Users\TZ\.dsh\…`); the key value is
never in argv, the run's config, a log or evidence (ADR-0058).

**Restage before every run** (the run dirties the arm):

```sh
node dev/bench/prep.mjs --force \
  --src C:/Users/TZhen/Desktop/Aetherium-Bastion \
  --sibling C:/Users/TZhen/Desktop/racoons-bench/_sibling-parked-2026-10-27 \
  --root C:/Users/TZhen/Desktop/racoons-bench/2026-10-23-aetherium
```

Expected: `racoons-arm: 1787 file(s) … multiset 9087422…` and the same for
`vanilla-arm`, sibling pin `508b1eec…` over 4,523 files, `IDENTITY PASS`.

**Product run:**

```sh
BENCH_REAL_API=1 node dev/bench/bench-run.mjs \
  --arm racoons --provider deepseek-official \
  --allow-official-spend --deny-web --workspace-only --require-done \
  --arm-dir C:/Users/TZhen/Desktop/racoons-bench/2026-10-23-aetherium/racoons-arm \
  --evidence scratchpad/launch/<date>-extended-32-n3/product-r<N>/evidence \
  --brief dev/bench/bench-brief-extended-36.md \
  --manifest dev/bench/manifests/2026-11-10-extended-36.manifest.json \
  --window-tokens 400000 --prune-threshold-tokens 60000 \
  --prune-ask-grammar nokeepall --entry-ask-trigger '{"mode":"off"}' \
  --token-grant 100000000 --kill-ms 14400000
```

**Vanilla run** (same, without the prune flags):

```sh
BENCH_REAL_API=1 node dev/bench/bench-run.mjs \
  --arm vanilla --provider deepseek-official \
  --allow-official-spend --deny-web --workspace-only --require-done \
  --arm-dir C:/Users/TZhen/Desktop/racoons-bench/2026-10-23-aetherium/vanilla-arm \
  --evidence scratchpad/launch/<date>-extended-32-n3/vanilla-r<N>/evidence \
  --brief dev/bench/bench-brief-extended-36.md \
  --manifest dev/bench/manifests/2026-11-10-extended-36.manifest.json \
  --token-grant 100000000 --kill-ms 14400000
```

**Acceptance, per run.** Exit 0 and `passed: true`; `citableAs` starts with
`measurement`; `checkpoints.source: "brief"`, `expected: 36`, `created: 36` for a fresh run; a resume reports `expected: 4`, `created: 4` with the 32 prior records present;
`watchdog.tokenGrant: 100000000`, `tokenFired: false`, `timeoutMs: 14400000` (this
shape's values; ADR-0058 sets no timer requirement);
`usage.usageRows` equals assistant turns; `coverage.reconciled: true`;
product `hostPruner.state: "disabled"`, vanilla `hostPruner.state:
"host-default"`; `readBoundary.violations: []`. Record the post-run tree digest
into the evidence dir before restaging. A run that fails the read boundary or
the gate is replaced, never averaged.

**Evidence.** `scratchpad/launch/<date>-extended-32-n3/<arm>-r<N>/evidence/`
(`result.json`, `launch.json`, `stdout.ndjson`, `requests.jsonl`, `task.txt`,
`patch.yml`, `dump-config-host-pruner.yml`, `racoons/cremator-events.jsonl` for
the product, `sessions/…/session.v4.jsonl` for both). `freeze.txt` and the
per-run logs sit beside them.

**Results so far (the 32 brief, 2026-11-09; the 36 brief and the resume have no runs yet):**

| Run | Product true / cost | Vanilla true / cost | Peak context |
| --- | --- | --- | --- |
| r1 | 31,087,717 / $0.3428 | 30,509,938 / $0.2696 | 247,207 / 319,744 |
| r2 | 29,052,434 / $0.3395 | 39,151,642 / $0.3675 | 254,646 / 319,706 |
| r3 | 23,963,392 / $0.3215 | 35,770,455 / $0.2712 | 248,988 / 319,612 |

Medians: product 29.05M / $0.340; vanilla 35.77M / $0.271. Tokens −18.8%,
dollars +25.2%. The r3 vanilla is the replacement for a draw that ran `git`
above the world and failed the boundary; that draw is excluded. Cost prices an
ask by its cache split (`(input − cached) × $0.15/M + cached × $0.003/M`); see
`reference.md` for the pruner mechanics and the 320k compaction boundary.

**Resume the 32-record sessions (the dsh half of the longer set).** Restore
that run's 32 records into the arm before launch (the campaign saved them under
`<evidence>/workspace-records`), then:

```sh
BENCH_REAL_API=1 node dev/bench/bench-run.mjs   --arm racoons --provider deepseek-official   --allow-official-spend --deny-web --workspace-only --require-done   --arm-dir C:/Users/TZhen/Desktop/racoons-bench/2026-10-23-aetherium/racoons-arm   --resume scratchpad/launch/<run-dir>/<arm>/evidence   --task-file dev/bench/bench-brief-extended-36-followup.md   --window-tokens 400000 --prune-threshold-tokens 60000   --prune-ask-grammar nokeepall --entry-ask-trigger '{"mode":"off"}'   --token-grant 100000000 --kill-ms 14400000
```

The vanilla resume is the same without the prune flags and with
`--arm vanilla`. A resume skips the manifest gates; the follow-up file's final
list is the four new names. The arm must hold the 32 prior records or
`resumeDeliverableGate` refuses by name.

**Not this shape.** opencode is parked at ISSUE-256 and has no citable 32/32
run; do not launch it under this section. The older 13-file and resumed steps
below are history and must not be mixed with the 32/32 fresh runs.

## Paths (two device forms)

| Thing | `C:\Users\TZhen\` device | `C:\Users\TZ\` device |
| --- | --- | --- |
| Source repo | `C:\Users\TZhen\Desktop\Taskworld-Project` | `C:\Users\TZ\Desktop\Taskworld-Project` |
| Template (frozen source) | `C:\Users\TZhen\Desktop\racoons-bench\2026-10-23-taskworld\miliastra-game-template` | `C:\Users\TZ\Desktop\racoons-bench\2026-10-23-taskworld\miliastra-game-template` |
| Bench material | `C:\Users\TZhen\Desktop\racoons-bench\2026-10-23-taskworld` | `C:\Users\TZ\desktop\racoons-bench\2026-10-23-taskworld` |
| This repo | `C:\Users\TZhen\Desktop\racoons` | `C:\Users\TZ\Desktop\racoons` |
| Credentials | `C:\Users\TZhen\.dsh\.credentials.yaml` | `C:\Users\TZ\.dsh\.credentials.yaml` |
| zcode records | `C:\Users\TZhen\.zcode\cli\agents\` | `C:\Users\TZ\.zcode\cli\agents\` |

Material lives outside both repos; only these committed files enter git.
An evidence dir is `scratchpad/bench/2026-10-23-taskworld/<arm>/`; mock modes add
`-mock`, `-mock-perturb`, `-mock-replay`, `-mock-replay-perturb`, `-preflight`.

## Step 0 — freeze the arms and the sibling

```sh
cd C:/Users/TZhen/Desktop/racoons
SIB=C:/Users/TZhen/Desktop/racoons-bench/_sibling-parked-2026-10-27
node dev/bench/prep.mjs --sibling "$SIB" --dry-run     # size scan, writes nothing
node dev/bench/prep.mjs --sibling "$SIB"               # both arms + frozen sibling + manifests
```

`--sibling` is required: name the parked frozen copy, never the live
`C:/Users/TZhen/Desktop/miliastra-game-template` checkout, which has drifted from
the pin. The run refuses (exit 2) unless the sibling hashes to the round pin in
`dev/bench/manifests/2026-10-23-taskworld.manifest.json` (`508b1eec…`, 4523
files), printing both digests. Expected `IDENTITY PASS`. Re-running without
`--force` exits 2 by design; a root
holding an entry this script never writes is refused even with `--force`. A
dirty source tree is allowed: `source.dirtyPaths` records it and both arms get
the same bytes; exact counts are `reference.md` § "What prep.mjs writes". Then
`diff -r racoons-arm vanilla-arm` prints only two manifest lines — `arm` and
`identity.otherArm`. A pristine copy for re-runs is `_pristine/<arm>-arm`; never
re-run a real arm as a baseline.

## Step 1 — prove the deny, per arm

The launcher carries the eight rows from `subagent-deny.md` in every
`patch.yml`, last, and evaluates both probe legs from the session log. Mock leg:
`--provider mock --dry-work` (Step 2); `deny-probe.txt` must say `DENY PASS`,
leg B showing a real `subagent` call that failed `UNKNOWN_TOOL` /
`ToolNotFoundError` with the text `Error: unknown tool "subagent"`.
Perturbation, once per campaign: `--omit-deny-rows` must make the header offer
all six names and the summon must not fail that way — a probe that stays green
with the rows removed measures nothing. Real leg, per arm, in Step 3: the same
`patch.yml` on the real route.

**The two legs are scored apart from the arm (ISSUE-038).** Leg A is a hard
failure everywhere; leg B is the probe's own outcome, never an arm assertion. A
`partial` leg B on a real route is `expected` (nothing in the brief invites a
summon) and leaves `result.json.passed` `true`; the mock lanes treat it as a
measured-nothing probe and exit **3**. Table, exit codes `0`–`4`, read boundary:
`dev/bench/launch-contract.md`. Never pool a probe run with a bench run: mock
evidence lands in `<arm>-mock/`, a perturbation in `<arm>-mock-perturb/`.

## Step 1b — the offline test: replay a recorded session through both arms (`mock-replay`)

Runs the same loopback mock from a `.zcode` session record instead of the
hand-written smoke script: no real API, no key, no money — an **offline test**.
It measures harness parity and context mechanics, **not** update quality (ISSUE-023). The **sim test** is `dev/sim/sim-batch-live.mjs` (recorded session, real key, tool trigger); the `.mjs` planners there that read a transcript with no key are offline analyses, not sim tests. Step 3 is the **full live test**.

```sh
cd C:/Users/TZhen/Desktop/racoons          # other device: C:/Users/TZ/Desktop/racoons
REC="<home>/.zcode/cli/agents/sess_36755af8-c4fb-44dd-b37d-5147b2630bb1/agent_dcb70387-fc1e-429d-89ac-8aa0158c9ccc/transcript.jsonl"
MAP=dev/bench/replay-map/2026-10-23-dcb70387-scan-memoization.json

node dev/bench/bench-run.mjs --arm vanilla --provider mock-replay --dry-work \
  --record "$REC" --record-map "$MAP" --allow-host-pruner
node dev/bench/bench-run.mjs --arm racoons --provider mock-replay --dry-work \
  --record "$REC" --record-map "$MAP"
```

The vanilla command may still carry `--allow-host-pruner`, but on that arm the
flag is now a no-op: since ADR-0055 the launcher writes no pruner row there, so
the arm runs at the host default and replays a recording made with it on
(`hostPruner.optOut` is null). The flag remains only the racoons arm's opt-out;
the racoons command does not take it, so the pairing is a host-vs-product
comparison, not a product-alone measurement.

Do not restore the old `c9a68f18` record and `2026-10-23-c9a68f18-adr-edits.json` map: the map says `scriptedTurns` 10 while the current converter maps 24, so `buildReplay` exits 2 (`scriptedTurns 10 != 24 scripted`), and 9 synthetic keys are unmapped.

`<home>` is `C:\Users\TZhen` on one device, `C:\Users\TZ` on the other. Both
flags are required; the map binds the record sha256, `textCap`, `maxReplies`,
`turnCount`, `scriptedTurns` and `textMode`, and a mismatch is exit 2 **before** any process
starts or any prior evidence dir is wiped. Every mapped target must exist in the
arm for the same reason: exit 2, naming the absent files. Long-record mode: set `REC` to `<home>/.zcode/cli/agents/<sess_*>/<agent_fbfafdb6-*>/transcript.jsonl` and `MAP` to `dev/bench/replay-map/2026-10-24-fbfafdb6-combat-lock.json` (226 replies, 138 MiB; dcb70387 at 41 replies is the shorter one). No `--inflate-bytes`: the record reaches ~230k estimated tokens itself, and the compaction lane is served on every run, so a real compaction is measured and cuts the replay — an accepted end state, since the record gates assert the completed prefix.

On a measurement run, do not name a frozen dist: the frozen trees predate the current source, and the default path rebuilds from source and is the only one that carries the current rules. A determinism or gate run that must read the same build as the run it checks may pin that build's frozen copy, but that is a gate, not a measurement: the copy is pinned for the gate only, never for the measurement that produced its artifact.

Evidence lands in `<arm>-mock-replay/`. `script.json` is the converted,
path-rewritten script plus a `replay-end-trN` terminator that stops the
conversation where the record does, and on the racoons arm a prune prefix (next
section). The deny leg is **skipped** (`denyProbe: "skipped"`): a record carries
no `subagent` call, so the probe stays on `mock-smoke` (Step 1) and the skip is
never a partial pass. `result.json`: `provider: "mock-replay"`, `usageIsEstimated`.

### Synthetic pressure (`--inflate-bytes`) — compaction on mock

A record too short to reach the trigger leaves the compaction row vacuous.
`--inflate-bytes N` adds ASCII filler to every scripted shell result. On the
racoons arm the pruner is already off (ADR-0041), so the filler reaches
`compaction-basic` and makes its row measurable; the vanilla arm keeps the host
pruner at the host default (ADR-0055), so there the pruner trims the filler and
the compaction row stays vacuous. Append it to the racoons command above for the
compaction row; `dev/bench/ref-synthetic-pressure.md` has the rest.
**synthetic pressure measures the cap/compaction MECHANISM under load, not real-record economics.**

### Prune lane (racoons arm)

Since ADR-0028 there is exactly ONE table asker: the bulk prune. With two ask
moments in the product (the entry checkpoint and the bulk prune), a mock-replay
run has no second table lane to route between and no row-count test. The
prune pass (`runPrune`, ISSUE-022) asks on a fork of main's wire state, so the
ask carries main's tools and ends with the shipped table final line. A converted
record carries no table replies — the recorder never asked one — so without
scripted rows the first ask would be a mock `no-match` (500).

The racoons script therefore starts with 16 `prune-table-forgetall-NN` rows
(`pruneReplyRows`): each matches `PRUNE_MATCH_PATTERN`, the escaped final line,
`$`-anchored, with no `tools_length` and no row count, because a fork ask may or
may not carry tools and a 1-row table is the normal tail of a pass. The reply is
`{{forgetallTableAnswer}}`, which expands to `forgetall` for every index the ask
carries; `meta.replay_prune: true` marks the row. A **queue**, not a set: no
ordinal in the matcher, so every ask is answered and rows past the last ask are
never reached (16 is a ceiling). The rows are **replay-external**: `replay:
consumed prefix N of M scripted replies` and `fidelity: request keys match the
served script per turn` count record rows only (`mainReplies` drops
`meta.replay_prune`), mirroring the rig's `mainRequests`. The vanilla arm gets none; an ask there is a
failure. Evidence, not a target: `mockReplay.pruneRows`, `tableAsks`,
`pruneAsks` and the `tableRows` histogram.

### The delay-ratio flags

`--window-tokens <n>` sets the mount's `contextWindowTokens` (the half-window
prune trigger; half of `n` is the threshold on the mount's transcript-only
estimate). On a real route (racoons arm) the default is **400 000**
(owner clarification 2026-10-24: the owner's 200 000 is the big-prune firing
bar, not the window; the window is the host's native 400 000, so the bar lands at
200 000 and the native backstop stays at 400 000); the mock lanes keep the
shipped `null` (trigger off). It belongs to the racoons arm only.

The host's own `tool-result-pruner` is arm-dependent on every provider (ADR-0055:
the vanilla arm prices the host as shipped, the racoons arm measures the mount
alone). The vanilla arm writes no pruner row, so the host default stands (on) and
its `compaction/prune` events are the host's own work, accounted as that arm's
lane; the racoons arm writes `- id: tool-result-pruner` / `disabled: true`
(ADR-0041: it is a competing mechanism), so the mount is the only remover. The
sim states `runHostPruner: "none"` (a replay mounts no pruner of its own), so the
vanilla lane is a host-vs-product comparison against a recording made with the
mechanism, never a product-alone measurement. `--allow-host-pruner` remains the
racoons arm's one opt-out and is a no-op on vanilla; a racoons run that takes it
is not a product measurement, and its first forced loss may be the host pruner's
trim, not a `compaction/start`. `--end-pressure-isolation` is the same choice
under its older spelling, still needing `--inflate-bytes`.
`result.json.hostPruner` records the arm's `state`/`disabled`/`optOut`, the
composed row counts and the session log's `compaction/prune` count; a racoons run
meant to be pruner-free fails the gate on any such event. The pressure block
keeps `syntheticPressure.isolation.ended` and the row counts for older readers.

### Fidelity assertions (the ones that separate the arms)

Projection parity across arms is harness parity: they differ in `arm` and in
`script_sha256` (the racoons script carries the prune prefix). Fidelity is read
from racoons-side evidence and the served script, per run, never from a baseline.

| Assertion | Expected side comes from | Fails when |
| --- | --- | --- |
| `replay: no request went unmatched` | the mock's own log | the host sent a key the record never had |
| `replay: consumed prefix N of M scripted replies` | the served script's record rows, in order (prune rows excluded) | a turn is skipped, repeated or reordered; on a host compaction the green detail says `cut by host compaction` and `mockReplay.consumedPrefix` records N and M |
| `replay: the <arm> arm's table asks are answered` | the mock's log: every table ask matched a `prune-table-forgetall-NN` (racoons); none arrived (vanilla) | an ask fell through to `no-match`, or vanilla asked |
| `fidelity: request keys match the served script per turn` | `match.tool_results_count` and `match.last_assistant_tool_names` in `<evidence>/script.json`, read back from disk | one request's count or tool names leave the scripted value |
| `fidelity: tool failures are exactly the scripted constant` | a shallow simulation of the script's `edit`/`write` calls over the frozen arm | a failure appears that the script did not script, or a scripted one is missing |
| `fidelity: the <arm> arm's journal is present and parsed` | `<evidence>/racoons/cremator-events.jsonl` | the racoons arm wrote no journal, a line is not JSON, or vanilla emitted one |
| `fidelity: the <arm> arm's journal carries the mount's own mounted line` | `mounted.storageRoot` in that journal vs the `crematorStorageRoot` this run configured | the line is missing (a stub cannot write one) or names another root |
| `fidelity: the <arm> arm's ledger holds every published recall` | journal `publish.recallId` vs the closed `ledger.sqlite` | the mount published an archive the ledger never prepared |
| `fidelity: no cap archives exist (ADR-0014)` | ADR-0014 scrapped cap materialization, so the value is 0 by ruling | any `publish` archive carries `operationKind: 'cap'` |
| `fidelity: the <arm> arm's tool/result replacements match the applied removals` | the journal's applied lanes (`prune-apply status=applied` `removals` + `entry-apply status=landed` + `forget status=applied` + the host's `compaction/prune` count when the composed config leaves `tool-result-pruner` mounted, which since ADR-0055 the vanilla arm and a racoons opt-out do) vs `tool/result` `replace` ops in the session log | a replace has no lane behind it, or a lane applied and left no replace. `user/message` replaces are the keep-all rewind lane and are NOT counted (no removal behind them). A vanilla run's stored replacements are the host pruner's own trims: its expected count is the `compaction/prune` count, not zero |
| `fidelity: the journal's applied removals match the ledger's application_removals rows` | the journal's applied lanes vs the ledger's rows for intents recorded `applied`, and each applied `recall_id` vs the `recalls` table | a journal removal has no ledger row, or an applied recall id is absent from `recalls` |
| `replay: no tool result failed on a path` | every `tool/result` row | the path map sent a read to a missing file |
| `replay: every read succeeded` | every `tool/result` row | a replayed read errored |
| `replay: the mocked call order matches the script` | the served script's call names | the host ran tools in another order |

The failure constant is five `edit` calls under `FS_EDIT_NOT_FOUND` (prose from
the source repository; no path map can match it). Counted, never hidden, and in
the projection as `tool_failures` (`count`/`by_code`/`by_tool`).

**Journal and ledger: real evidence, not a narration.** A racoons run on
`mock-replay` or a real route mounts `dev/dsh-rig/rig-plugin.mjs` (the wrapper
around the same shipped entry), so the racoons arm writes
`<evidence>/racoons/cremator-events.jsonl` and the entry's own per-session
`<evidence>/racoons/storage/sessions/<id>/ledger.sqlite`. The real-route path was
added to this list by ISSUE-082: before it, only the replay mounted the wrapper
and every real run silently dropped its journal. `result.json`'s
`mockReplay.journal` (replay) or `journal` (a real route) carries
`file`, `lines`, `byKind`, the counts derived from them and the ledger's
summary; kinds and field list are `reference.md` § "The journal". Counts are
**evidence, not a target**: the gates assert agreement between artifacts, never
a count. `capArchives` is the one invariant value — ADR-0014 scrapped cap
materialization, so it is 0 by ruling and any other value is a removed mechanism
coming back. The replacement gate is an equality between two artifacts, so a
record with no removal stays green at 0 == 0. The journal gate also demands the
mount's own `mounted` line naming this run's storage root, a line nothing but
the mount writes. Every run scans now, the vanilla control included: a vanilla
run that carries a journal or a ledger fails by name, and any `tool/result`
replace it stored fails the replacement gate (expected zero). A racoons `mock`
run mounts the shipped entry (no sink), so its journal rows are
`not-applicable`. Perturbed by `--plugin-entry <dist>/…/plugin.js` (no sink),
`--perturb-journal-caps 1` (a `cap` archive invented in the in-memory counts)
and `--perturb-journal-parse` (a bad line); none takes `--projection-out`.

**Perturbation (must fail by name):**

```sh
node dev/bench/bench-run.mjs --arm racoons --provider mock-replay --dry-work \
  --arm-dir scratchpad/bench/2026-10-23-taskworld/_pristine/racoons-arm \
  --record "$REC" --record-map "$MAP" --perturb-swap-match 3,4
```

Reply 3's matcher and reply 4's are exchanged in the per-run script copy only
(the committed map and any baseline are untouched); the prune prefix is outside
that numbering. On the retired `c9a68f18` record the run exited 1 with
`FAIL: fidelity: request keys match the served script per turn: request 3
(turn-03-tr4): expected tool_results_count 5, saw 4`; that line is the retired
record's example, not a claim about the working `dcb70387` record. It may never
carry `--projection-out`; its evidence dir gains `-perturb`.

### Step 1c — the determinism gate (same arm, twice)

Two mock-replay runs of one arm must produce a byte-identical projection. The
baseline comes from an earlier **green** run and lives **beside** the evidence
dirs (that dir is wiped at start). Use `_pristine/<arm>-arm`.
```sh
cd C:/Users/TZhen/Desktop/racoons          # other device: C:/Users/TZ/Desktop/racoons
EV=scratchpad/bench/2026-10-23-taskworld
BASE=$EV/racoons-mock-replay.projection.json
COMMON="--arm racoons --provider mock-replay --dry-work --arm-dir $EV/_pristine/racoons-arm
  --record $REC --record-map $MAP"

node dev/bench/bench-run.mjs $COMMON --evidence $EV/racoons-mock-replay-det1 --projection-out "$BASE"
node dev/bench/bench-run.mjs $COMMON --evidence $EV/racoons-mock-replay-det2 --projection-in "$BASE"
```

Run 2 exits 0 with `projection identical to <file> (8 keys)`. A drift exits 1
with `FAIL: canonical projection matches the stored baseline: projection differs
in N key(s)`, one `  <path>: expected …, actual …` line per drifted key, and the
same list under `projection.diffs`. Guards, all exit 2: the flags need
`--provider mock-replay`; out and in are never combined; either path inside the
evidence dir is refused; a missing `--projection-in` is refused before any
process starts. Key list: `reference.md` § "The projection"; the prune prefix
is constant across runs of one arm, so `script_sha256` stays stable.

## Step 2 — the launcher

```sh
# smoke: mock LLM, scratch work copy, the real arm tree stays pristine
node dev/bench/bench-run.mjs --arm vanilla --provider mock --dry-work
node dev/bench/bench-run.mjs --arm racoons --provider mock --dry-work

# static composition check: no process, no provider call.
# The 2026-11-08 live route is official deepseek-flash; the flags below are the
# 2-option run's, with no --allow-read, no --require-done and no --kill-ms.
# This argv is historical: ADR-0058 withdrew the law that shaped it, so its 60M
# grant and checkpoint stop are not current policy. A current preflight sets any
# local grant at or below the 200M soft cap; no timer is required.
node dev/bench/bench-run.mjs --arm racoons --provider deepseek-official \
  --allow-official-spend --deny-web --workspace-only --preflight \
  --brief dev/bench/bench-brief-extended.md \
  --manifest dev/bench/manifests/2026-10-27-extended-round.manifest.json \
  --window-tokens 400000 --token-grant 60000000 \
  --prune-threshold-tokens 60000 --prune-ask-grammar nokeepall \
  --entry-ask-trigger '{"mode":"off"}' \
  --stop-at-checkpoint docs/plans/2026-10-27-extended-audit/07-plan-traceability.md
```

`--help` prints the flag list; the flag table and mount row are `reference.md`
§ "Launcher flags". `--dry-work` is required for both mock modes. `--manifest`
asserts the brief and the arm against the round manifest and is free, so a
launch names it; omit it only for a round that has no manifest.
`patch.yml` is one file, in this order: base rows (mock: session root; a real
route: the tier-3 overlay), the `racoons-mount` insert row when `--arm racoons`,
the no-official-endpoint rows (unless `--allow-official-spend` authorizes the
official host), the `--deny-web` rows when that flag is given, then the eight
deny rows **last**, so no earlier row can re-open them. The vanilla arm gets no
mount row: its native compaction stands, and `compaction-basic` stays mounted in
both. On a real route `DSH_HOME` stays real and the `credentials` row is
re-enabled pointing at `RIG_CREDENTIALS_PATH` (a **path**, never the key); no
provider key is exported. The launcher first clears every inherited provider
key and `RIG_*` name, then sets only what this run means to use:
`RIG_CREDENTIALS_PATH`, `RIG_SESSIONS_DIR` and `RIG_STORAGES_DIR` on a real
route, and `CREMATOR_RIG_DIST` when the rig wrapper is mounted. Real runs need
`BENCH_REAL_API=1`.

### Official spend is opt-in by name (ISSUE-176, ruling 2026-11-05)

By default no bench row may reach `api.deepseek.com`. The six rows that can —
`web-search-deepseek` (Messages search, one model turn per search),
`web-deepseek-api` (Search/Fetch API), `web`, `tool-web`, `llm-deepseek` (the
`deepseek-official` adapter) and `llm-deepseek-account` (tokens minted for that
origin) — stay disabled unless the run passes `--allow-official-spend`.
`web_search`/`web_fetch` go with `web`/`tool-web`, so they are never offered by
default. `llm-deepseek` is removed on every REAL route only — on the mock lanes
it IS the transport to the loopback mock. `web-fetch-http` stays: anonymous, no
credential, and unreachable once `web` is gone.

`--allow-official-spend` is required for `--provider deepseek-official` and
`deepseek-v4-pro`. Without it a live run exits 2 before anything is wiped, and
`--preflight` writes the closed patch, prints
`official-route-provider=… spend=REFUSED`, then FAILS with a message naming the
flag. With it the official rows mount (including `web`/`tool-web`), preflight
prints `spend=AUTHORIZED`, and `launch.json`/`result.json` record the route and
the owner authorization. The 2026-11-08 2-option run pairs it with `--deny-web`:
the four web rows are re-closed after every row the opt-in may have opened, and
`preflight` prints `web-tools=DENIED` with each of the four `disabled` or fails
by name. The flag changes nothing on the mock lanes.

Every other run keeps the old gate: `--preflight` prints the verdict as
`official-routes=` and FAILS when a row that is an official route by identity,
or whose composed text names `api.deepseek.com` or `DEEPSEEK_API_KEY`, is still
ENABLED. The one exemption is the route's own transport (`llm-pi-ai` on the two
official providers, `llm-deepseek` on the mock lanes), and the line names it.

## Step 3 — launch the one-arm 2-option plumbing check

The 2026-11-08 run is a **throwaway plumbing check**, one arm (`racoons`), not a
pair. The command below is its argv; the vanilla arm is not launched. The
3-option sanity run was a **censored single-arm plumbing check, not a control**
and is not evidence for the 2-option design. This 2-option run cannot test the entry lane
(the entry ask is off) and has no 3-option-versus-2-option same-run A/B. Older
argv records are historical and are not this run's command. This argv is
historical too: ADR-0058 withdrew the law that shaped it, so its 60M grant and
k=8 checkpoint stop are not current policy. The current shape is at the top.

```sh
cd C:/Users/TZhen/Desktop/racoons && BENCH_REAL_API=1 node dev/bench/bench-run.mjs \
  --arm racoons --provider deepseek-official \
  --allow-official-spend --deny-web --workspace-only \
  --arm-dir scratchpad/launch/2026-11-08-live-rerun/racoons/arm \
  --world    scratchpad/launch/2026-11-08-live-rerun/racoons \
  --brief dev/bench/bench-brief-extended.md \
  --manifest dev/bench/manifests/2026-10-27-extended-round.manifest.json \
  --window-tokens 400000 --token-grant 60000000 \
  --prune-threshold-tokens 60000 --prune-ask-grammar nokeepall \
  --entry-ask-trigger '{"mode":"off"}' \
  --stop-at-checkpoint docs/plans/2026-10-27-extended-audit/07-plan-traceability.md
```

`--prune-ask-grammar nokeepall` selects the two-verdict bulk table: `forgetall`
and `keeplines` only; a whole unit is a full-range `keeplines` with its answer
key `forgotten` set to `None` (the value names the dropped content; legacy
`summary` is accepted), and a literal `keepall` is a terminal `action-not-in-grammar` refusal
that keeps the row (ADR-0053). It is also the shipped default (ADR-0056); an
explicit `--prune-ask-grammar 3option` selects the original contract instead. On
`deepseek-official` / `deepseek-flash` the eligibility floor is 512 bytes
(ADR-0051), the uncalibrated model default; the record states it.

- **No `--allow-read`.** The brief reads only inside the arm (T2 tells the agent
  not to resolve `../` paths), and `--workspace-only` fails the run (exit 4) on
  any tool call naming a path outside the arm/world. The old template-checkout
  allowance is not passed.
- **No `--require-done`.** A checkpoint stop is a censored partial, not a pass.
- **`--stop-at-checkpoint` is k=8** (`07-plan-traceability.md`), or the
  60,000,000 grant, whichever comes first. This is the historical run's stop
  shape, not current policy (ADR-0058). The file must be absent at launch.
  The stop goes through the normal result path and writes `result.json`
  (`stoppedBy`, `stop.benchDone.found`, deliverables, peak, compaction,
  journal/ledger, ask lane); claims are gated on `benchDone.found`, never
  `passed`. No `--stop-after-compactions` is armed.
- **The arm is single-use.** Stage fresh from
  `scratchpad/bench/2026-10-23-aetherium/_pristine/racoons-arm`; the run edits it
  in place and never gets a second pass.
- **`git init` an EMPTY repo at the campaign root before launch.** That is the
  git-channel barrier: without it `git log` in a world with no `.git` climbs into
  this repo and prints treatment-side commit subjects into the transcript
  (ISSUE-079 run 1). `scratchpad/launch/2026-11-08-live-rerun` is that repo.
- **`--judge-timeout-ms` stays OFF** — run C's prune asks timed out at the
  30000 ms default, and comparability dies if the rerun moves that deadline.

`--kill-ms` is OFF in this historical argv. ADR-0058 withdrew the old law: any
timer value, including off, is now admissible, and no timer is required. The
token grant and the file checkpoint were this run's stops; the grant meters the
TRUE total (main prompt + main output + ask prompt + ask output), and the ask
lane's true cost is also recorded in `result.json.askLane`. The 60,000,000 grant
was the historical local stop. Under ADR-0058 the policy cap is a soft
200,000,000 true tokens per run (main prompt + output + ask prompt + output +
compaction), and a run may exceed it with a recorded justification; the alarm is
advisory and kills nothing. No output cap is declared:
the route row carries no `maxTokens` key, so the host/model default applies. A
paid launch without `--manifest` is refused (the spend would bind to no round);
the manifest is free and closes the stale-brief gap: a drifted fence hash or
block size, or an arm tree whose digest is not `image.digest`, is exit 2 before
anything is wiped. `result.json.tree` records the pre-launch digest.

The working directory is the arm directory itself; the run edits it. One arm
runs, so there is no arm order and no pair confound. A later pair must fix its
order before its own pre-registration.

**The read boundary (ISSUE-039).** `--world` gives the arm its own directory;
`--workspace-only` makes the arm world the only readable root; no `--allow-read`
root is passed. `launch-contract.md`.

## Step 4 — identify every arm in evidence

Every evidence path carries the arm name, so a mislabelled folder shows in its
own path; inventory and `result.json` fields: `reference.md` § "The evidence dir".

## Step 5 — collect

1. The arms carry no `.git`, so `git status` says nothing. Record the post-run
   identity with `node dev/bench/prep.mjs --dry-run --no-sibling --src <arm>`:
   it prints the included count and the multiset digest without writing, and
   `--dry-run` lifts the root-overlap guard so the arm can be scanned in place.
   Paste that into `final-tree.json` in the evidence dir; the reviewer diffs it
   against the pre-run `manifest.json`. Never edit an arm after that.
2. Record the termination cause: exit code, the last `stdout.ndjson` event
   (`type: final` or nothing), `stderr.log`. `result.json`'s `watchdog.fired`
   is the box's own record; a box hit leaves no `final` and is a **timeout**,
   scored separately, never pooled. Record `BENCH-DONE` from `session.benchDone`.
3. Do not clean `scratchpad/` between arms; collect both before deleting.

## Step 6 — anonymize for blind review

```text
scratchpad/bench/2026-10-23-review/arm-A/   <- one finished tree
scratchpad/bench/2026-10-23-review/arm-B/   <- the other
scratchpad/bench/2026-10-23-review/key.txt  <- the A/B -> arm mapping
```

The operator writes `key.txt` and does not open the review copies again; the
reviewer prompt names `arm-A`/`arm-B` only. The racoons journal sits in the
evidence dir, outside the tree, so the copies stay clean; a reviewer who can
still tell the arms apart rejects the pairing.

## The opencode bench

This file's two-arm procedure is the dsh bench. The opencode bench is a separate
launcher:

```sh
node dev/bench/opencode-run.mjs --arm vanilla --slug opencode-vanilla
node dev/bench/opencode-run.mjs --arm test --kill-ms 600000 --slug opencode-test \
  --control-evidence scratchpad/launch/<date>-opencode-vanilla/vanilla/result.json
node dev/bench/opencode-run.mjs --arm test --replay-db <opencode.db> --replay-session ses_… \
  --control-evidence <vanilla result.json>
```

The vanilla arm must share the whole world identity with the test arm: the
replay database's sha256, the model id, the provider id, the capture
mechanism's sha256, the host binary's sha256, the fixture-file hashes, the
workspace source digest, the script sha256, the session id, the host version and
the task sha256, every field non-null. Its `result.json` must also be usable as a
control: exit 0, no bench refusal, a whole capture, the same task completed, at
least one measured request-stability pair, `plugin.mounted === false` and
`ledger.exists === false`. `passed`, `citable` and the control lanes are **not**
read: a lane miss neither binds nor unbinds. A `null` field on either side
never binds. A test-arm removal claim without `--control-evidence` is
`removal (control procedural, not bound)` and is not citable, whatever its
restore shape.

The shipped synthetic source is `dev/bench/fixtures/opencode/replay.db`, session
`ses_RAC00NS5YNTH3T1C0000000000` (its `manifest.json` names it). Its stored
directory is `C:\RACOONS-SYNTHETIC\workspace`, which does not exist on this
machine; the seed points the world's copy at `<armDir>/world/work` and records
`replay.seeded.relocation.from` / `.to`. A stored path that does exist is left
unchanged. The shipped replay script's superseded-read lane is a 20,923-byte
unit, below the host's 51,200-byte reader cap, so its `necromancy` restore comes
back whole; the stale-read lane's 200,000-byte unit is cut and restored as a
pointer. The run's claim names that shape,
`removal (restore whole for 1/2 restorable of 2 recall ids (live 2, seeded 0; excluded 0); pointer-only 1)`.
`k/n` counts restorable recalls, `l`/`s` split them into live and seeded, `r`
the ledger's recall ids and `e` the excluded ones, so an exclusion never leaves
the denominator silently and a seeded restore is not counted as live. A seeded removal (a
unit the source session already carried) is excluded from the restore claim as
`seeded-not-restore-proven` **only when no captured body carries its unit result
before the removal**; `restore.exclusionReasons` names each excluded recall and
why. When a before-body exists, the restore is judged byte for byte like any
other: a whole one is counted and the claim is
`removal (restore whole for k/n restorable of r recall ids (live l, seeded s;
excluded e))`; different returned bytes fail by name. When no restorable recall exists the
restore row is `not-applicable` (a void row), never a green measured row. The
seeded-row check records the columns the host rewrites
(`hostRewrites: ["session_v2.model"]`) and leaves only those out of the row hash;
any other seeded row change, including a message body, still fails. Real-route
reasoning may arrive intermittently: a reply without reasoning is counted in
`repliesWithoutReasoning` and does not fail, while a reasoning string that
appeared in a reply must still appear in later requests.

It runs the installed opencode 2.4.0 binary headless against the loopback mock
(`opencode-mock-model.mjs`), never a paid route. Evidence is
`scratchpad/launch/<yyyy-mm-dd>-<slug>/<arm>/` (`result.json`, `launch.json`,
`journal.jsonl`, `mock/requests.jsonl`, the ledger). Exit 0 = passed and citable;
3 = passed but not citable; 1 = failed; 2 = refused. The one-line status the
runner prints on stdout carries `citableAs` beside `passed`, `citable`,
`removalMeasured`, `claimScope` and `claim`, so a **passed** run that exits 0
still names the claim it supports and what that claim is measured on
(`claimScope: "captured-request-bodies (send not proven); a request that bypassed
the hook is outside this claim"`). The `claim` record also says how the control
was bound: a test-arm removal claim is citable only when
`--control-evidence <vanilla result.json>` binds it (its `schema` is this
runner's, its `runId` is non-empty, its `capture.jsonl`, `stdout.ndjson` and
`session.v4.jsonl` siblings hash to the `artifacts` it records, and its control
subject is bound: replay database, model, provider, capture plugin, host binary,
fixture and workspace hashes, script hash, session id, host version and task
sha256 all non-null and equal to the test run's. The vanilla must also be usable
as a control: exit 0, no bench refusal, a whole capture, the same task completed
(deliverable gate and final text), at least one measured request-stability pair
with no unexplained disappearance outside a recorded compaction boundary,
`plugin.mounted === false` and `ledger.exists === false` as booleans, and at
least one verified removal on the test arm. `passed`, `citable` and the control
lanes are **not** read: a lane miss neither binds nor unbinds. `removals.applied`
is a strict check only when an available journal measured it, else `not-measured`).
A hand-written result with no artifacts, or
a copied one whose artifacts do not hash to its record, binds nothing. Without
it the claim is `removal (control procedural, not bound)` and is not citable,
whatever its restore shape. A real-route run
whose model never called `necromancy` exits 0 with
`citableAs: "removal (archived exact bytes; restore not exercised)"`: the
archived exact bytes were proven absent as a decoded string from every later
parsed request body (the raw body is searched where the capture carries it; a
re-encoded body is not covered) and stored in the ledger's blob files, but no
restore was attempted. The claim states the exceptions exactly: the removed text
reappears only (a) under a new call id (first declared at the removal or later)
declaring a read of the same file path, (b) inside another removed unit's own
result, whose own check verified that unit's removal, or (c) in the answer to
that recall's own run-issued `necromancy` restore (retained live under
ISSUE-259; a whole restore of a single-line result carries the archived text). A
same-path re-read is **not required** (ISSUE-256 item 3): a candidate passes on
a before-body, its later absence, and either a same-path survivor — recorded as
a fact from its landing request onward — or a same-tool control present inside
the measured segment. The measured segment runs from the recall's first receipt
to the next recorded compaction; a recall whose every measurable unit has no
observed presence inside its segment is `not-applicable` with a named reason
(`before-body-before-compaction`, `compaction-boundary-unplaceable`,
`survivor-after-compaction`), never a pass. A recall's hidden unit is
`not-applicable` and disclosed, and the candidate is measured on its remaining
units — the same rule as an outside part; the candidate fails only when no
measurable unit remains. A pointer-only restore is citable and can exit 0 as
`removal (restore whole for 1/6 restorable of 6 recall ids (live 6, seeded 0; excluded 0); pointer-only 5)`;
exit 0 alone never means every removed unit came back byte for byte. On a
seeded replay the removal claim's presence record carries
`label: "presence-from-seed (disclosure, not evidence)"` when the run also
answered a reply frame; a record with seeded reasoning and no answered frame is
`presence-seed-only`, `present: false`, and is not citable. The removal or
control gate needs at least one **run-carried** reasoning part (`answered > 0`),
never the seed alone. Read `citableAs`, never the exit code alone. The perturbation matrix and the evidence
inventory are in `reference.md` § "The opencode bench".

### The real route: capture from the host's own `http.request` hook

The mock route's `mock/requests.jsonl` is the request capture. A real route has
no mock, so the launcher mounts `opencode-capture-plugin.mjs` beside the product
plugin. The host calls `session.hook("http.request")` with the `Request` it is
about to send; the plugin clones it, never mutates it, and appends one JSON line
per event. The loader the host imports is generated per run at
`<armDir>/capture/plugin.mjs`; its log is `<armDir>/capture.jsonl`, and its exit
summary is `<armDir>/capture.jsonl.summary.json`.

**The frozen-task live command (the current shape).** This is the opencode arm of
the live rerun: the agent works in a staged writable copy of the frozen task
repo; the source is only read, and a source write is detected after the run.
`--allow-read` names the sibling template (read-only, narrow). The host's
saved-output cache is the one tolerated read outside the work copy: a direct
child of `<arm>/world/.local/share/opencode/tool-output` named
`tool_<12 lowercase hex><id>` is recorded as a `host-cache` row, never a
violation unless its real target leaves the cache, which is `symlink-escape`
(ADR-0057 decision 2). The shell
(`shell`, plus its `bash`/`execute` aliases) is denied by the benchmark config
because the extended brief does not require it; the checkpoint reader is a
separate offline step.

The command below assumes `DEEPSEEK_API_KEY` is already set in the operator's environment. Do not
put it on the command line: a `DEEPSEEK_API_KEY=… node …` prefix is key material in argv and shell
logs, and ADR-0058 requires key material out of argv, the run's config, logs and evidence.

```sh
cd C:/Users/TZhen/Desktop/racoons      # other device: C:/Users/TZ/Desktop/racoons
node dev/bench/opencode-run.mjs \
  --arm test --provider deepseek-official --i-am-the-owner --kill-ms 14400000 \
  --token-grant 100000000 \
  --workspace C:/Users/TZhen/Desktop/racoons-bench/2026-10-23-aetherium/racoons-arm \
  --allow-read C:/Users/TZhen/Desktop/racoons-bench/2026-10-23-aetherium/miliastra-game-template \
  --allow-native-compaction \
  --task-file dev/bench/bench-brief-extended-36.md \
  --expect-final BENCH-DONE \
  --replay-db dev/bench/fixtures/opencode/replay.db \
  --replay-session ses_RAC00NS5YNTH3T1C0000000000 \
  --script dev/bench/opencode-workspace.script.json \
  --control-evidence scratchpad/launch/<yyyy-mm-dd>-opencode-extended-vanilla-<pair>/vanilla/result.json \
  --ask-grammar jsonl-20-nokeepall \
  --prune-threshold-tokens 60000 --context-window-tokens 400000 \
  --slug opencode-extended-test-<pair>
```

Both arms of a pair must pass the same `--script dev/bench/opencode-workspace.script.json` so
the control subject can bind (`scriptSha256` is compared; the default is chosen per mode and
is never the 1c control's `ff916af…`: a replay source that is the shipped fixture `replay.db`
with its manifest session id defaults to `dev/bench/fixtures/opencode/fixture.script.json`,
`7e7b17…`; any other `--replay-db`/`--replay-session` source defaults to
`dev/bench/opencode-replay.script.json`, `ba72e5…`; a fresh real route with no seed defaults
to `dev/bench/opencode-offline.script.json`), and the test arm must point `--control-evidence`
at a vanilla `result.json` whose control subject matches. Both arms carry
`--allow-native-compaction`: the frozen brief is long enough to force the first native
compaction (`bench-brief-extended-36.md:17`), and without the flag the
`compaction: no compaction request was posted` assertion fails, the arm exits
nonzero, and the vanilla then fails `vanilla-exit` in `controlEvidenceVerdict`. `<pair>` is
`1`, `2` or `3`: each pair carries its own number on both arms (the vanilla runs as
`--slug opencode-extended-vanilla-<pair>`, the path the test arm's `--control-evidence`
names), because the bench refuses an evidence directory that already exists and never
deletes a previous run. Control binding compares the **task-block** sha256 — the first fenced
block under `## Task text`, trimmed — not the brief file sha256: the file is `efc1101c…`, but
the block is `774c9b32…`, identical to the 1c vanilla control's `controlSubject.taskSha256`.
Every subject field must be non-null and equal to the 1c control's: replay database
`5d29aa4f…`, model `deepseek-flash`, provider `deepseek`, capture plugin `071a1442…`, host
binary `0c346f…`, fixture `none`, workspace `9087422d…`, script `ff916af…`
(`opencode-workspace.script.json`), session `ses_RAC00NS5YNTH3T1C0000000000`, host version
`2.4.0`, task `774c9b32…`. When every field matches, the 1c vanilla control can bind a current
test arm: a fresh test arm is required, and the vanilla control may be reused. Both arms
still pass the same `--script dev/bench/opencode-workspace.script.json`, so `scriptSha256`
matches the 1c control's `ff916af…`.

**Campaign note.** The n=3 medians require the runner and adapter hashes to be equal across the three pairs before averaging: each pair's `harness.before.sha256`/`harness.after.sha256` (both arms) and each test arm's `artifact.distSha256`.

`--ask-grammar jsonl-20-nokeepall` mounts the bench-only ask on the test arm. The
product shape is depth-triggered: `--prune-threshold-tokens 60000
--context-window-tokens <host window>` are required with the grammar (the runner
refuses the pair when either is absent). The ask fires in the `context` (step)
hook at a crossing: the mount tables every unasked or kept eligible unit and
calls `session.generate` once; `session.idle` is only its fallback. The
bench-only per-revision cadence must say its name with `--ask-every-revision`
and refuses the two depth flags.
`session.idle` applies no removal: it runs the ask fallback when the step did not
ask, then journals the turn-end observation (`at-rest`, reason `turn-end`, status
`observed`) and commits nothing, because the array it sees is not the array the
host sends. The ask's answer is applied at the next step, so an idle ask can
still lead to a removal on the next request; `session.idle` applying no removal
does not mean an idle ask never leads to a removal. The prompt is the product
table: `forgetall` and `keeplines` only. A readable `forgetall` is applied as one
prune-document removal through the core prune path; a partial `keeplines` is
applied by re-emitting the kept lines inside the typed result part; a
whole-range `keeplines` with `forgotten` `None` keeps and re-tables the unit at a
later crossing; a literal `keepall` is the terminal `action-not-in-grammar`
refusal that keeps the unit and is never re-asked (ADR-0053 and ADR-0054
§Amendments 2026-11-23). The first table ask states the 70 percent share line and
every later ask the 40 percent one. The ask is off by default
(the shipped mount makes no ask), and its tokens are reported under
`spend.ask`. The split is
exact on the loopback mock and best-effort on the real route, where a host
`step_finish` row may include the generate step and cannot be split by kind;
`grantBasis` names the conservative direction. This pair is seeded hybrid and
makes no delay claim; ADR-0043 keeps auto-compaction on.

The second device spells both roots `C:/Users/TZ/Desktop/...`. The source must be
`racoons-arm` (1,787 files, digest `9087422d…`), never the campaign parent; the
manifest check refuses a source whose `totals.multisetSha256` does not match.
The extended brief ends `BENCH-DONE`, so the launch passes
`--expect-final BENCH-DONE`; the launcher's default is `DONE` and would fail the
brief's final text. The vanilla arm is the same command with `--arm vanilla`, **no
`--ask-grammar`** (the ask is test-arm only), **no `--control-evidence`** — the
code reads the self-referential path and records an unbound `controlEvidence`
block on the vanilla otherwise — and its own `--slug`; each arm stages its own copy.
The `--replay-db`/`--replay-session` pair is an
owner decision that stands unchanged (ADR-0045: the seed must carry sendable
reasoning). Read the single status line's `citableAs` and `passed`; exit 0/3 is
not the claim.

The checkpoint/overhead read is offline and runs after both arms finish:

```sh
node dev/bench/opencode-checkpoints.mjs \
  scratchpad/launch/<yyyy-mm-dd>-<slug>/test/stdout.ndjson \
  scratchpad/launch/<yyyy-mm-dd>-<slug>/test/result.json --json
```

It names the thirteen deliverables by exact path, reports billed prompt/fill/
peak/compaction per checkpoint, and states the host compaction position by
`compaction.atMainRequests` (primary-request index) while keeping `atRequests`
as the capture sequence. There is no overhead token row: on a `host-step-tokens`
basis the runner and the reader sum the same `step_finish` rows, so
`overall.stepTotalDifferenceTokens` is 0 and a nonzero value is a reader
mismatch, not auxiliary tokens; under a capture basis the total is reported as
`captureEstimate` and nothing is subtracted.

**Legacy: the synthetic fixture run (not the frozen-task shape).** The command
below is kept for the fixture lanes only. It has no `--workspace`, no
`--task-file` and no `--allow-read`, so it does **not** run the extended brief
and must not be used for the live rerun. The fixture script carries the task its
lanes are keyed to, so the command runs the unit read, the superseding re-read
and the twin marker read the control needs.

```sh
cd C:/Users/TZhen/Desktop/racoons      # other device: C:/Users/TZ/Desktop/racoons
node dev/bench/opencode-run.mjs \
  --arm test --provider deepseek-official --i-am-the-owner --kill-ms 1800000 \
  --token-grant 40000000 \
  --replay-db dev/bench/fixtures/opencode/replay.db \
  --replay-session ses_RAC00NS5YNTH3T1C0000000000 \
  --slug opencode-fixture-real
```

**`--task` overrides the script's own task and defeats the lanes.** The script
selects its replies and lane boundaries by the task it carries; a `--task` on
the command line replaces it, so the model is not asked to read the unit and the
fixture lanes never run. Pass `--task` only for a different database whose
script you also supply (this is also a legacy fixture shape, not the rerun):

```sh
node dev/bench/opencode-run.mjs \
  --arm test --provider deepseek-official --i-am-the-owner --kill-ms 1800000 \
  --token-grant 40000000 \
  --replay-db <fixture.db> --replay-session <session id> \
  --slug opencode-deepseek-real --task "<bounded task>"
```

The key is read from the operator's environment only; never put it in argv, the config or
the task. The opencode runner currently refuses a live real route without `--kill-ms` and
`--token-grant` (`dev/bench/opencode-run.mjs`, the real-route guard). That is a runner guard, not
an evidence condition: under ADR-0058 any timer value is admissible, and the grant is a local stop
below the soft 200M cap. **The grant is compared against prompt + completion tokens: completion is
counted only from the source the meter used — the host's own `step_finish` rows
supply it whenever they printed, and the request capture alone supplies none.
The kill timer is the wall bound.**
The request log is polled while the child runs, a sum above the grant kills the
tree, and `result.json.spend` records `{ billedPromptTokens,
billedCompletionTokens, billedTokens, grant, fired, completionMetered, source,
meterBasis, capturedEstimatePromptTokens, capturedPromptTokens, hostPromptTokens,
bounds }`. On a real route the meter reads **both** the captured request bodies
and the host's own `step_finish` tokens; a complete host step reading is
`billedPromptTokens` even when the capture estimate is larger, and only an
absent or incomplete host reading falls back to the larger prompt+completion
total, so an observer that never loaded cannot leave the grant silent. Before
the child is spawned, `captureLoaderRefusal` checks the generated plugin
directory; a loader the host would not resolve is refused before spend. The observer hooks `http.request`, so it records request bodies and
never a response: the capture alone carries no completion tokens,
`completionMetered` is false when no complete host step row printed, and a real
route with unmetered completion fails the `spend: completion tokens were metered
on the real route` check by name, while a mock row's `usage.completion_tokens`
is summed when present. A fired
grant fails the run. The mounted core's build must be
fresh too: core
`dist/` older than core `src/` refuses the launch, and a core with no `src/` is
`coreBuildFresh: "unverified"` and cannot be cited. Both arms may mount the
observer; the vanilla arm mounts nothing else.

A replay of that database with its manifest session id uses
`dev/bench/fixtures/opencode/fixture.script.json` by default. The database is
hashed at launch and must equal the manifest's `sha256`; a mismatch is refused
by name, because the fixture script describes the manifest's history and not
another one. The fixture's
seeded history ends on a user turn, so the general replay world's reply order and
lanes do not describe it; `opencode-fixture-script.mjs` generates the script this
fixture needs. Its lane carries the unit read, the superseding re-read and a
**distinct twin marker** read (`big-b-twin.txt`, its own sentinel), so the
vanilla control proves two results survived, not one sentinel.
`--script <path>` still overrides the choice, and the result's `script.source`
says which file was used.

Each line carries `seq`, `at`, `sessionID`, `agent`, `model`, `kind`, `method`,
`url`, headers with `authorization`/`cookie` reduced to `{ present }`, and the
body: `bodyBytes`, `bodySha256`, `body`, `truncated`. `kind` is the host's
`SessionRequestKind` (`primary | compaction | title | generate`). Only
`kind: "primary"` is a main turn; title, compaction and generate counts are
recorded separately and never satisfy a main-turn check. Title and compaction are
**derived from the body's own prompt** (`title_prompt`, `compaction_prompt`), not
from `kind`: a `primary` line whose body carries the title prompt, or a `title`
line whose body does not, fails the capture check. A fresh run must post exactly
one body-derived title; a replay posts at most one. A request with no body (the
host's `GET /models`) keeps its line as `bodyless: true` with `bodyReadable:
false`, `bodyBytes: 0` and no error; no body check reads it. A line whose
`truncated` is true, whose body is unreadable, whose byte count or hash disagrees
with the body, a body-bearing line with **no** `bodySha256`, a dropped line, or a
plugin write error recorded in the summary sidecar makes the run un-citable
(`capture.blocked`). A missing sidecar leaves the dropped count unknown and is
un-citable for the same reason. The sidecar's `lines` must equal the file's own
line count plus its `pending` count: a body read still in flight when the process
exits is in neither the file nor `lines`, so the capture is incomplete and
`capture.blocked` is true even though no line looks wrong.

The hook fires **before** the send and carries no attempt number. A capture
line does not prove the send, the HTTP framing or a retry, and lines must not be
counted as model calls. This is a captured-request-body record, captured before
send, not a record of what the provider received.

The real route's removal verdict reads no fixture lane. **Every `recall_parts`
tool call id is its own unit.** Each unit's call id and **exact result text** must
be absent from every request after the recall's **first receipt**; a receipt
naming the recall id must be present, the ledger's blob files must hash to their
rows, and each unit's archived tagged result, lowered to the host's wire text,
equals that unit's captured pre-removal bytes (the part's
`blob_sha256`/`source_sha256` are checked against the stored blob file). The
absence scan reads every string of every message, not
only tool results; a receipt line is checked against the unit's and its twins'
call ids and its exact result text before it is allowed through. A **new** call
id carrying the removed text is a twin only
when its first declaration is at the removal (or later) and is a read of the
same file path; `command` and `pattern` are not paths, and the unit's own call
id is never a twin. A unit with a captured before-body is measured; a unit whose
exact result text reappears outside the exceptions named below — including a result that
already carried those bytes before the removal — is `not-applicable` with reason
`re-exposed-under-later-result`, not a failed candidate. The claim states the
exceptions exactly: the removed text reappears only (a) under a new call id
(first declared at the removal or later) declaring a read of the same file path,
(b) inside another removed unit's own result, whose own check verified that
unit's removal, or (c) in the answer to that recall's own run-issued
`necromancy` restore (retained live under ISSUE-259; a whole restore of a
single-line result carries the archived text). That same-path
re-read is a survivor, not a requirement (ISSUE-256 item 3): it is recorded as a
fact from its landing request onward, and a unit with no survivor passes only
when a same-tool control is present inside the measured segment; a recall whose
every measurable unit has no observed presence inside its segment is
`not-applicable` with a named reason, never a pass. A recall's hidden unit is
`not-applicable` and disclosed, and the candidate is measured on its remaining
units — the same rule as an outside part; the candidate fails only when no
measurable unit remains. A **mixed recall** (a
tool unit plus a text or reasoning part) is checked part by part: its tool parts
are measured, its non-tool part is recorded as `nonToolPart` and excluded from
the byte claim. A tool part that never reached a captured request body is a
`candidate.outsideCallIds` entry: it is never byte-checked and is recorded in
`notApplicableParts` as `not-applicable` with a named reason, excluded from the
measured removal. That skip is disclosed in the claim's
`(N unit(s) not-applicable: …)` suffix and does not block the run, which can
still be cited for its measured units. A **recall** in `removals.outside`
(`callIdOnlyRecallIds`, check `no-locatable-tool-call`) is a different fact: it
names no tool call id this bench can locate (a non-tool part, or no part at
all), so no captured body can show its bytes left; it blocks `removals.measured`
and a citation by name. Only a `necromancy` call **this run issued** counts as
exercising the restore: its id must first appear after the first captured
request and must not be in the source session's `perCall` map; a call already in
request 1 is seeded history, and a call only in the last request has no later
body to carry its result. **Every run-issued attempt for a recall must be
correct**: a wrong earlier attempt fails it even when a later one returns the
right bytes, and `restore.rows[].attempts` records each call. When the restore
was not exercised, `removals.restore.exercised` is
false, `pass` is null and there is no failure: the claim is `removal (archived
exact bytes; restore not exercised)` and the run can be citable. When every
recall is seeded with no captured before-body, the restorable set is empty and
`restore.status` is `not-applicable`: the restore assertion is a void
`not-applicable` row, never a green measured row, and the claim is
`removal (marker only; restore not exercised)` — never a bare `removal`. A
run-issued restore that returns different bytes keeps `pass: false` with named
failures.

The vanilla control on a real route groups the run's **live** reads by the file
path each call declares (`filePath`/`file_path`/`path`; a command or pattern is
not a path). A live read's call id first appears after the first captured main
request, so the seeded read of the unit file is never counted. The shipped
fixture's script declares `expectedReads`
`{"big-b.log": {count: 2, sentinel: …}, "big-b-twin.txt": {count: 1, sentinel: …},
"hello.txt": {count: 1, sentinel: …}}`: the second read of the unit file is
required, and the seeded read satisfies no count. A read counts only when its
own result text carries the declared fixture sentinel; ENOENT, an empty file or
another file's bytes do not count (audit 21). Each counted
read's own result message must appear, addressed to its own call id with the
same strings, in every later main request. The lane's unit files are the unit
half and the other expected files are the twin half; both are required, so a
file the task asks for and the model never read fails the control. A fixture
that declares no `expectedReads` falls back to the byte-marker control, where a
twin the model never read is `not-exercised`, not a failure. The vanilla claim
states what was measured: `citableClaim` emits `control (no result disappeared
without the mount; 0 compaction requests)` on the mock/fixture route as well as
the real route, and `control (no result disappeared without the mount; <count>
host compaction request(s) recorded; no delay claim)` when the vanilla's own
capture carries host compaction requests; on the real route the claim never
rests on a lane. The lane claim `control (the unit and its twin survive without
the mount; no mount, no ledger, removal count not measured)` (the shorter
`control (the unit and its twin survive without the mount)` when a journal
exists) describes a fixture lane's two halves; it is not the `citableAs` label on
either route.
`removals.applied` is `not-measured` without a journal and is excluded from the
binding's strict check count; the claim says `no applied removal measured (the
record carries no journal)`.
`--expect-final <text>` names the literal final assistant
text the task asks for (default `DONE`) and is recorded as `task.expectFinal`.

Replay a previous capture without launching anything:

```sh
node dev/bench/opencode-run.mjs --capture-log <armDir>/capture.jsonl --arm test
node dev/bench/opencode-run.mjs --capture-log <armDir>/capture.jsonl --arm test \
  --replay-capture
```

`--capture-log` reads the log (and the ledger/journal beside it, when present)
through the same `runBench` the tests use. It launches no host, needs no
script/mock/binary, and reports `hostLaunched: false`; the tool-table,
reasoning, content, removal, restore and byte-delta checks read the captured
bodies. A first primary body that carries seeded history is used as the replay
source: its strings seed request 1 and its reasoning is the sendable bound, and
the output records `replayCapture` and its reason. There is no source database
and no stored seed description on this route, so the two request-1 equality
checks compare that body with facts derived from it whenever the capture is
seeded (and whenever the task itself came from the body). They are recorded as
`self-consistency:` assertions with `contributesToPassed: false`, listed under
`selfConsistency`, and `requestOneBaseline` is `self-consistency`; they do not
count toward `passed`. Only a fresh capture with the task named on the command
line keeps them counted. `--replay-capture` forces the seeded reading when the
first body's shape is ambiguous. Without a ledger or
journal its storage checks are `skipped`, not failed.
