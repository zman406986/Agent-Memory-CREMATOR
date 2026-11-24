# dsh test rig — matrix status after ISSUE-014

Binding plan: `archive/2026-10-22-dsh-test-rig.md`. Slice C built the racoons mount and the two
scenarios §10.3 names; ISSUE-014 moved the mount into the shipped `cremator-dsh/plugin` entry and
folded S7. This file says exactly which §6 rows that made green and which are still blocked, and why.

## Row status

| Row | State | Evidence |
| --- | --- | --- |
| S1 Cap of an oversized result **plans** a removal | **superseded (ADR-0014)** | The entry-time cap is scrapped, so the scenario is now `scenarios/oversized-result-uncapped.json`: a 49 KB result is carried whole, the entry seam captures it, and nothing rewrites it. |
| S2 Cap **applies** as a surface replacement | **superseded (ADR-0014)** | No cap plan, marker or archive can exist. The replacement leg that survived is the entry checkpoint's (`run-entry-e2e.mjs`). |
| S3 Seal of a failed-search episode | **green** | `scenarios/seal-failed-search.json`: two zero-match `grep`s (`meta.total === 0`, `truncated === false`) in one step; the turn-end at-rest pass seals the closed episode; one negative fact, no removal, evidence derived as `miss` (not `unknown`). |
| S4 Seal applied at rest | **green** (append leg, with S3) | The session log holds one appended `user/message` whose `source.kind` is `racoons/negation` and it is the newest surface message; its text equals the published record byte for byte; the ledger's own summary records one sealed episode id. The row's "the next request's history contains it" clause is **not** assertable in this run: the seal lands at the turn-end seam, after the final request of a one-shot run. Asserting that clause needs a second-run resume or a two-turn script, which is a later scenario, not this one. |
| S5 Revert via shadow-replace | **documented-blocked** (seam landed, scenario unbuilt) | ISSUE-024 chunk 1 landed the seam: the mount derives the host revert session (`packages/adapters/dsh/src/mount-revert.ts`) and declares `revertHistory` only when one exists, and `enforcement` now defaults to `apply` per ADR-0008. The one fact still blocking a live apply: dsh exposes no cache watermark, so core's fresh zone starts at the transcript end and every cut is refused `cut-below-watermark`. The scenario stays unbuilt rather than faked. |
| S6 Seam facts the adapter assumes | **green** | `agent/pre-step` precedes each request (the mount journals one `at-rest` per step and the cap scenario asserts a request count equal to the scripted steps); every `tool/result` carries `data.message` (the mount maps `message.content` to the item body); the outbound `messages` order equals the harness history (the replay projection check covers this, unchanged). |
| S7 A failed result is never delivered | **green** | `scenarios/failed-result-not-delivered.json`: one oversized `pwsh` success and one failing `read` whose not-found body is also large; the mount observes the failure for the transcript, journals one `skip` with `reason: 'failed-result'` for the read, and leaves the failing result unreplaced in the session log. The spec row also names the three mock failure shapes (4xx, SSE `error`, truncated stream); those end a run non-zero at the *request*, not as a tool result, so they are covered by `mock-messages.test.mjs` and are not an S7 case. |
| §8 tier 3, real call | **green, opt-in** | `scenarios/tier3-real-api.json` with `RIG_REAL_API=1 RIG_KILL_TIMER_MS=120000`. Exit 0 in 8.6 s; 2 requests; `assistant/message` usage rows carrying 246 output tokens total; `request/context` stamped with the route's provider and model; the answer named `port = 99999`. 16 assertions, including "mock never started" and "no record names 127.0.0.1". Perturbation (disable `credentials`) failed by name with `MISSING_CREDENTIAL` and zero usage rows. |
| S8 The judge ask round-trips | **removed (ADR-0028)** | The judge pass and its scenario were deleted by ISSUE-067 CHUNK-3. No judge lane exists. |
| S9 The bulk prune's table ask round-trips | **green** (record leg) | `scenarios/prune-recorded.json`, two launches: launch 1 leaves two units (one oversized result per turn), launch 2 resumes with `/prune` as the whole user message. Journal: one `prune-requested` → `prune-plan` (`units: 2, askRows: 2`) → one `prune-table` → one `prune-recorded` (`reason: null, round: 1, asks: 1`, every count zero for an all-`keepall` map). Zero `publish` records. 39 assertions (2026-10-27); perturbation (delete the table row) failed by name on `the prune pass asked every batch` and `mock has no unmatched requests`. |
| S8 across a restart (ISSUE-004 chunk 5) | **green since ISSUE-074** | `scenarios/durable-recall.json` now carries `contextWindowTokens: 40000` and an `answers.entry` keepall queue: launch 1 crosses the half window and runs round 1 (keepall), launch 2 resumes the stored session, crosses again, and round 2 forgets launch 1's result, minting the recall id the recall leg restores byte-exact. 28 assertions; both launches exit 0. The resumed launch is also the ISSUE-074 proof: before scheme A the stored answer row was an `assistant/message` outside every step and dsh refused the whole log. |
| The keep-all boundary | **green (pin)** | `scenarios/keepall-final.json`: after an entry `keepall` settles, the same boundary's prune pass re-lists the kept unit (plan units 1, askRows 1) — the shipped reading of ADR-0028 §4 / ADR-0025 §4. ISSUE-073 records the open question; the pin records the actual behaviour. |

## The table lane (ADR-0028: the bulk prune is the one asker)

A table request is a fact about the wire, not about the script: its user message carries the ask
frame (`The messages above are main's production conversation…`) and ends with the shipped final line.
`mock-messages.mjs` classifies it `prune` whatever its row count and logs that kind, so
`mock.mainRequests` keeps meaning "turns the agent loop sent" and `mock.pruneRequests` counts the asks.

The script row, placed **before** every main row (first match wins):

```json
{ "name": "table-ask-keepall",
  "match": { "tools_length": "present",
             "last_user_text_matches": "maps every index above to its verdict" },
  "reply": { "type": "text", "text": "{{tableAnswer}}" } }
```

`{{tableAnswer}}` expands to one `{"<index>":{"keepall":true}}` entry per row the ask carries, so one
row answers a 1-row tail and a 12-row table alike. A forgetting answer is written out literally
(`{"1":{"forgetall":"…"}}`) or as `{{forgetallTableAnswer}}` for every index. `expect.prune` reads the
journal: `requested`, `recorded`, `round`/`rounds`, `asks`, `tableUnits`, `planUnits`, `planAskRows`,
the removal counts, `thresholds`/`threshold`, the apply fields and the negative surface/publish keys.

Every mount scenario needs an entry answer: the entry lane asks every over-floor result, and a script
with no `answers.entry` gets a loud 500 (`no-entry-answer-scripted`). `scenarios/prune-apply-auto.json`
and `scenarios/durable-recall.json` now carry a keepall queue (ISSUE-074). A multi-launch scenario
states a per-pass count as an ARRAY — `planUnits: [1,2,2]`, `tableUnits: [1,2,2]`, one value per
asked table in order — and a scalar keeps meaning "every table".

What still blocks an **apply-mode** e2e: the mount's port state is `cache: {kind:'unknown'}`
(`packages/adapters/dsh/src/port.ts`), and core's `computeFreshZone` starts the fresh zone at the
transcript end for unknown cache. The knob a caller must state is `port.updateState({cache: {kind:
'warm', watermarkNodeIndex: <n>}})`, which only the mount's own tests do; dsh exposes no watermark, so
the rig cannot. An applying scenario needs either a host-derived watermark or a stated one, never a
faked `warm`.

## What the mount is, and what it is not

`packages/adapters/dsh/src/plugin.ts` (subpath export `cremator-dsh/plugin`) is the shipped Cordis
plugin: `createRacoonsPlugin(options)` returns `{ name: 'racoons', inject: ['sessions'], apply(ctx,
config) }`. It owns the host mapping — which event becomes which `DshToolResultItem`, the turn/step
numbering, turn-end completion, the no-agent fallback, and the two publication shapes — and it calls
only the public `createDshAdapter` / `createDshPort` / `RacoonsEngine` seams.

`dev/dsh-rig/rig-plugin.mjs` is a thin wrapper: it loads the compiled entry from
`CREMATOR_RIG_DIST`, splits the rig's flat config into the entry's knobs plus `evidenceDir` / `log`,
routes the entry's journal to `<evidence>/racoons/cremator-events.jsonl`, and points
`crematorStorageRoot` at `<evidence>/racoons/storage`. It injects no ledger: since ISSUE-004 chunk 2
the entry's own durable seam is the product path, and the rig proves it rather than substituting
for it. A second launch on the same root resumes the same session directory, so the driver's recall
legs read a closed database a different process wrote.

`scenarios/product-mount.json` mounts through the shipped entry and asserts the journal has one
`mounted` line and the ledger file exists, so a regression that dropped the entry path fails by name.

## Compile step

A dsh child is plain Node and cannot import the workspace TypeScript. `dev/dsh-rig/build-dist.mjs`
runs the repo's own `tsc` with `dev/dsh-rig/tsconfig.rig-dist.json` and emits `packages/core` +
`packages/adapters/dsh` into `scratchpad/dsh-rig/dist/` (gitignored), plus the two `node_modules`
shims that make the bare `@cremator/core` and `cremator-dsh` specifiers resolve there. The build is
stamped by a hash of the tsconfig and every included source, so repeated scenario runs reuse it.
Nothing in the dist tree is committed. The wrapper imports the emitted
`packages/adapters/dsh/src/plugin.js`; the dist emits subpath files as plain paths, so no package
`exports` map is involved.

## Host facts slice C added to the spec's §1 list

Each was found by a live run, not assumed, and each changed the mount:

| Fact | How it showed |
| --- | --- |
| `step` restarts at 1 every turn; the core wants a monotone step ordinal. | The guard rejected every at-rest plan with `adjacency-changed` until the mount numbered `(turn, step)` pairs globally. |
| A turn is complete only at `turn/end`. | `completedThroughTurnOrdinal = current - 1` left the search episode open past its own turn; the seal never fired. |
| A one-shot headless run sends no request after its final step. | The turn-end seal lands at the newest seq, after the last outbound request; "the next request carries it" cannot be asserted for the run that appended it. The cap scenario *can* assert its outbound clause because its scripted conversation has a second turn. |
| The `agent/turn-stopping` payload may carry no agent. | `singleLiveSession` names the store's one live session; with zero or two it refuses rather than guess. More than one live session would need a dsh-side identity this hook does not carry. |
| An append-mode seal produces no archive, so no blob. | `blobRoot` asserts only for a cap scenario; a seal's witness is the ledger's `sealedEpisodeIds` and the appended record's bytes. |

## Host facts ISSUE-014 added

| Fact | How it showed |
| --- | --- |
| A tool failure arrives as `tool/result` with `data.message.isError: true`, and its text is `Error: <message>`. | The S7 scenario's missing `read` logs `isError: true` while the successful `pwsh` result logs `isError: false`. A failed call is still a normal surface result, so it must be *observed* and simply not delivered to the entry seam. |
| The host's `ctx.tools.register` takes a `ToolDefinition` whose `output` is mandatory (`{schema, render}`), while the adapter's seam is `{spec, execute}`. | The shipped entry maps the one handler-backed tool (`recall`) itself and registers it once at mount; `forget` and `expand` stay unregistered because they have no handler. No live scenario exercises this yet — the mock never calls `recall`. |

## Host facts tier 3 added

Each was found by the tier-3 smoke on 2026-10-22, not assumed:

| Fact | How it showed |
| --- | --- |
| The credentials store can be pointed at its real file without copying it. `credentials-local` takes `path`; feeding it `!!js process.env.RIG_CREDENTIALS_PATH` keeps the home directory out of the patch file and the key out of the environment. `dsh --dump-config` composes the row as `disabled: false` with that `path`, so the service is live before the first request. | The first tier-3 run resolved the provider key with `DSH_HOME` set to the real `~/.dsh` and no key in the environment. |
| The real route resolves from a `--patch` overlay alone; the web profile's `cordis.patch.yml` spelling works verbatim in headless (`api: openai-completions`, `apiKeyEnv`, `baseURL`, model id). | `request/context` in the session log carries the route's `provider` and `model`; no `baseURL` correction was needed. |
| Disabling the `credentials` row fails the run at the **first request**, not at boot. The process exits 1 with `MISSING_CREDENTIAL` on stderr and writes a session log with no `assistant/message`. | The perturbation leg: `dsh: MISSING_CREDENTIAL: llm-pi-ai: no credential for provider route "…" …`. This makes the perturbation free — it spends no tokens. |
| Real usage rows include `cacheReadTokens`; the first request's `totalTokens` already reflects cached prompt bytes. Assert on `outputTokens` for non-vacuity, never on `totalTokens > inputTokens`. | The two rows: `{input:240, output:81, total:7617, cacheRead:7296}` and `{input:605, output:165, total:8194, cacheRead:7424}`. |
| A real run completing in ~9 s leaves the 120 s timer unused; the timer is a bound, not a schedule. | `watchdog.fired` is `false` in every tier-3 `result.json`. |

## Running it

```sh
node --test "dev/dsh-rig/**/*.test.mjs"
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/oversized-result-uncapped.json
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/seal-failed-search.json
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/product-mount.json
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/failed-result-not-delivered.json
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/keepall-final.json
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/prune-recorded.json
```

These live runs exit 0 with the watchdog armed; evidence lands under
`scratchpad/dsh-rig/<date>-<slug>/`. Their perturbations were applied and each failed by the named
assertion, then restored green: `oversized-result-uncapped` (a body the result never contains),
`seal-failed-search` (write the needle into `alpha.txt`), `product-mount` (delete the `racoons`
block → "racoons plugin mounted: saw 0"), `failed-result-not-delivered` (`skippedFailedResults: 0`),
`keepall-final` (`planUnits: 0` → "the plan counted the in-memory units"),
`prune-recorded` (delete the table row → "the prune pass asked every batch: expected 1 answered
prune ask(s), saw 0").

Measured 2026-10-27 (`dsh 0.2.1-rc.2`, `node v24.19.0`): `oversized-result-uncapped` 27 assertions,
`failed-result-not-delivered` 27, `keepall-final` 41, `prune-recorded` 39 (two launches, each armed
at 180000 ms, neither fired). Since ISSUE-074 (scheme A) all four multi-launch scenarios are green:
`prune-apply-auto` 58 (three launches), `keepall-final` 41 with its new `secondLaunch` resume leg,
`durable-recall` 28 (two launches), `prune-recorded` 39.

## Replay conversion, measured

Source: `C:\Users\TZhen\.zcode\cli\agents\sess_94cd6919-…\agent_e99c7195-…\transcript.jsonl`
(1,471,748 bytes, 2,896 lines; other device: `C:\Users\TZ\…`). 3 `model_request`, 3 `model_complete`,
4 `tool_call_scheduled`; 3 turns mapped, 0 skipped; 2 project names and 2 home paths redacted; 0 leaks
after the `--check` scan. The committed fixture is `--text-mode placeholder`: assistant text becomes a
length marker and file paths become `replay/file-N.ext`, so no recorded prose, file name or path enters
the repo. Tool results never enter the script at all — dsh executes the scripted calls and feeds its own
results back.

Converter v2 maps the no-op family: `TodoWrite` becomes `todo_write` (the call's list
shape and statuses are kept, every recorded content string replaced by `replay todo N`)
and `TaskOutput`/`TaskStop` become the argument-free `job_list`. Both are real dsh tools
that exist in every arm and succeed, so the recorded call still advances
`tool_results_count` — the key every later turn is built on — while no recorded todo
prose or task id reaches a script. The 226-turn record
(`agent_fbfafdb6-…`, 144,740,284 bytes) converted as 226 replies with 0 skipped and 0
leaks; under v1 it stopped at reply 11 with `blocker: unmappable_tool:TodoWrite`.
A shell command that passes `SAFE_COMMAND` is still withheld when its own text trips the
leak scan; that is what keeps a record full of `/c/Users/...` arguments leak-clean.

