# dsh test rig

Offline, deterministic runs of the real `dsh` binary against a scripted mock LLM. No network egress,
no real key, no tokens spent. The binding plan is `archive/2026-10-22-dsh-test-rig.md`; this file
only says how to run what exists.

Status: slices A + B + C, plus ISSUE-014 (the shipped mount entry), ISSUE-058 P3d (the entry lane end
to end) and ISSUE-022 chunk 5 (the record-only `/prune` round-trip). Committed here:

| File | Role |
| --- | --- |
| `mock-messages.mjs` | Anthropic Messages SSE mock. Loopback only, `GET /health`, `POST /v1/messages`, per-request JSONL log with the lane (`main`/`entry`/`prune`/`compaction`/`post-compaction`/`title`; ADR-0028 removed the judge lane), title requests answered deterministically. |
| `run.mjs` | Driver: throwaway `DSH_HOME`, patch file, `workFiles` seeding, one `dsh --profile headless` process (plus an optional session-resuming `secondLaunch`), kill timer per launch, assertions, evidence, canonical projection. A scenario with a `racoons` block mounts the plugin. |
| `rig-plugin.mjs` | **A thin wrapper over the shipped entry.** Loads `cremator-dsh/plugin` from `CREMATOR_RIG_DIST`, routes its journal to `<evidence>/racoons/cremator-events.jsonl`, and points `crematorStorageRoot` at a throwaway directory under the evidence dir so the entry opens its own durable per-session ledger. It supplies no ledger: the product's storage seam is the one under test. The host mapping itself lives in the product package. |
| `build-dist.mjs` + `tsconfig.rig-dist.json` | **The compile step.** Emits `packages/core` + `packages/adapters/dsh` to `scratchpad/dsh-rig/dist/` (gitignored) and writes the `node_modules` shims, because a dsh child does not strip TypeScript. |
| `inspect-ledger.mjs` | Reads the rig ledger outside dsh: one recall by id (`--recall`) or the append-only summary. Used by the driver's ledger-side assertions. |
| `replay.mjs` | Tier-2 converter: a zcode `transcript.jsonl` becomes a mock script, with redaction, mapping stats and a leak scan. |
| `fixtures/replay-session.json` | One committed replay script (placeholder text mode: no recorded prose). |
| `fixtures/replay-session.projection.json` | The canonical projection a replay run must reproduce (determinism baseline). |
| `scenarios/smoke.json` | One-turn text-nothing-else smoke: proves the mock, the driver, and the session log. |
| `scenarios/tool-roundtrip.json` | Scripted `tool_use` → real dsh executes it → scripted second turn cites the result. |
| `scenarios/replay-conversation.json` | The committed fixture drives dsh; request keys, texts and projection are asserted. |
| `scenarios/oversized-result-uncapped.json` | **S1 after ADR-0014.** The entry-time cap is scrapped, so the surviving truth is pinned: a 49 KB `pwsh` result is carried to the wire whole, the entry seam captures it, and nothing rewrites it. |
| `scenarios/seal-failed-search.json` | **S3 + the applied seal.** Two zero-match `grep`s become one negative fact, published as an appended record and recorded in the ledger. |
| `scenarios/product-mount.json` | **The shipped entry, mounted.** The same `read` round-trip as `tool-roundtrip`, but the mount row names `cremator-dsh/plugin` and the run asserts the entry journaled a `mounted` line and opened a ledger. A regression that bypassed the entry path fails by name. |
| `scenarios/failed-result-not-delivered.json` | **S7.** One oversized `pwsh` success plus one failing `read`: the failure is observed for the transcript, journaled as `skip`/`failed-result`, never delivered to the entry seam, and nothing rewrites the surface. |
| `scenarios/tier3-real-api.json` | **Tier 3**, off by default: one real call over a 44-line fixture; asserts a real usage row, the provider's model stamp, a `read` tool result, no mock, no loopback. |
| `scenarios/keepall-final.json` | **The keep-all boundary, pinned.** One 49 KB result is asked at the entry checkpoint and answered `keepall`; the same boundary's half-window crossing runs the bulk prune, and the pin records the shipped reading of ADR-0028 §4: the plan re-lists the kept unit (units 1, askRows 1). ISSUE-073 records the open question about that re-listing. Its `secondLaunch` is the ISSUE-074 resume proof: a second dsh process reopens the session whose applied entry exchange is on disk and exits 0. |
| `scenarios/prune-recorded.json` | **ISSUE-022 chunk 5, the record-only `/prune` round-trip.** Two launches: the first leaves two in-memory units (one per turn's tool result), the second resumes the session with `/prune` as its whole user message. The pass asks the mock's prune lane with both indices, reads an all-`keepall` map, and writes one `prune-recorded` (reason null, round 1) with nothing published. |
| `scenarios/prune-apply-auto.json` | **ISSUE-022 chunk 6 + the ADR-0009 amendment, the apply leg.** Three launches on one session with `contextWindowTokens: 40000`, every entry ask answered `keepall`. Each launch crosses the half window once (launch 1 reads 20301 estimated tokens at threshold 20000), so rounds are [1,2,3]: round 1 keeps its one unit, round 2 forgets launch 1's result and applies one shaped turn, round 3 keeps both. Since ADR-0020 the in-flight exclusion is gone, so the plan numbers the just-landed result too (`askRows` [1,2,2]). Asserts one content-only surface replacement carrying a recall id, one `prune-apply` line (`applied`, one removal, `enforcement: apply`, `revertHistory: true`), and the `no-removals` skips for the keep-all passes. |
| `scenarios/durable-recall.json` | **ISSUE-004 chunk 5, durable recall across a dsh restart.** Two launches on one storage root with `contextWindowTokens: 40000` and an `answers.entry` keepall queue: launch 1 crosses and runs round 1 (keepall); launch 2 resumes the session, crosses again, and round 2 forgets launch 1's result, minting the recall id the `recall` tool then restores. Asserts the tool returns the origin bytes, one session directory, `ledgerSource: durable`, and the post-restart `recovery-pending` block on new removals. |
| `run-entry-e2e.mjs` | **The entry lane end to end** (ISSUE-058 chunk P3d). One real `dsh` session, four steps, the three answers scripted through `answers.entry`. Asserts the floor gate (over-floor asked, under-floor silent and journal-silent), keep-all rewind with the result node untouched, forgetall and keeplines as one atomic rewind+append each, the marker identity `landed = kept + gaps×markerBytes + summaryBytes + framing` with every term printed (every term measured: `kept` is located in the original body, so `framing` is the bytes that are none of the three), recall bound to the unit whose own marker named the id (byte-exact, whole body), and prefix discipline across the whole run. `E2E_FLOOR_BYTES` is its perturbation hook. |
| `run-entry-e2e.test.mjs` | The gate around that runner: green, red-by-name when the floor is moved out of reach, and the synthetic-evidence legs no healthy run can produce — a crossed recall id (A's id returning B's bytes), a re-keyed or truncated archive, and one extra byte in a shaped turn (the framing term must catch it). |
| `scenarios/entry-e2e.json` | The runner's scenario, rewritten each run beside it so the shape under test is reviewable in the diff. |
| `rig-plugin.test.mjs` | Wrapper tests only (entry load, config split, evidence routing, storage-root derivation); the mount's seams are tested in `packages/adapters/dsh/test/plugin.test.ts`. |
| `NOTES.md` | Which §6 matrix rows are green and which are still blocked; the table-lane recipe. |
| `reference.md` | The compile step, the mount's seams and the Tier 3 lane, in detail. |

Not built: `assert.mjs` (the driver's assertions are inline) and `revert-shadow-replace` (S5 needs a
stated cache watermark; see `NOTES.md`).

## Run

```sh
# every rig check. This glob includes run-entry-e2e.test.mjs, so the entry E2E
# gate runs too: two real offline dsh sessions on top of the unit checks.
# The mount's own seams are covered by packages/adapters/dsh/test/plugin.test.ts.
node --test "dev/dsh-rig/**/*.test.mjs"

# the compile step on its own; a no-op when the sources are unchanged
node dev/dsh-rig/build-dist.mjs
node dev/dsh-rig/build-dist.mjs --check

# one live dsh run against the mock
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/smoke.json
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/tool-roundtrip.json
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/replay-conversation.json
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/oversized-result-uncapped.json
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/seal-failed-search.json
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/product-mount.json
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/failed-result-not-delivered.json
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/keepall-final.json
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/prune-recorded.json
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/prune-apply-auto.json
node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/durable-recall.json

# the entry lane end to end (ISSUE-058 P3d): floor gate, keep-all, forgetall,
# keeplines, byte-exact recall, prefix discipline. Writes its own scenario and
# asserts from the evidence it leaves; about 5 s.
node dev/dsh-rig/run-entry-e2e.mjs
# the same run as a gate, plus its non-vacuity leg (a raised floor must fail it)
node --test dev/dsh-rig/run-entry-e2e.test.mjs

# tier 3: one real call. Both variables are mandatory (spec §8).
RIG_REAL_API=1 RIG_KILL_TIMER_MS=120000 node dev/dsh-rig/run.mjs --scenario dev/dsh-rig/scenarios/tier3-real-api.json

# convert a recorded zcode session (evidence goes to the scratchpad)
node dev/dsh-rig/replay.mjs --in <transcript.jsonl> --out scratchpad/dsh-rig/<slug>/script.json --check
```

The entry E2E gate runs in two tiers. `npm run check` (`test:dev` globs `dev/**/*.test.mjs`)
runs `run-entry-e2e.test.mjs`, which by default exercises only its synthetic-evidence legs — the
checks over evidence the tests build themselves. The three legs that drive a real `dsh` process
are opt-in: set `E2E_ENTRY=1` to run them.

```bash
# the synthetic legs only (the default, part of npm run check)
node --test dev/dsh-rig/run-entry-e2e.test.mjs

# including the three real-dsh legs
E2E_ENTRY=1 node --test dev/dsh-rig/run-entry-e2e.test.mjs
```

Run it alone while iterating on the runner. The same split applies to the other two live-shaped
lanes: `E2E_BENCH_FLAGS=1` runs the launcher-preflight tests in `dev/bench/bench-flags.test.mjs`,
and `E2E_OPENCODE=1` runs the `workspace run:` tests in `dev/bench/opencode-run.test.mjs`.

The spec's shorthand `node --test dev/dsh-rig` does not work on Node 22+: positional arguments are
glob patterns there, and a bare directory matches only itself, so Node tries to load it as a module.
Use the quoted glob above. Exit 0 means every named assertion passed; exit 1 names the first failing
assertion on stderr; exit 2 is a bad scenario or bad CLI use (no process was started).

The driver locates `dsh` via `npm root -g`, falling back to the `where dsh` shim directory; pass
`--dsh-bin <path-to-bin.js>` when neither works. It runs that `lib/bin.js` with the current Node, so
the watched PID is the real process and `taskkill /T /F` owns the tree.

## What every launch does (no exceptions)

- Throwaway `DSH_HOME` at `<evidence>/home`, scaffolded by dsh on first boot.
- `DEEPSEEK_BASE_URL=http://127.0.0.1:<ephemeral port>`, `DEEPSEEK_API_KEY=mock-key-not-real`.
- `DSH_TELEMETRY_DISABLED=1`, `DSH_TELEMETRY_MODE=DISABLED`, `DSH_PERMISSION_MODE=danger-full-access`.
- `--patch <evidence>/patch.yml` with `session-persistence-jsonl` restated as
  `compression: none`, so the session log is plain `session.v4.jsonl`.
- The kill timer is armed **before** the driver waits: `taskkill /PID <pid> /T /F` at
  `min(2 × timeoutMs, 180000)` ms, and on every abnormal exit path. The exact command lands in
  `result.json` under `watchdog.command`.

The child environment is rebuilt, and any inherited `DEEPSEEK_API_KEY` is deleted first.
The real key is never read, never printed, never copied.

## Evidence

`scratchpad/dsh-rig/<yyyy-mm-dd>-<slug>/` — gitignored and disposable, never cited by a ruling. The
directory is deleted at the start of every run so a stale artifact cannot satisfy this run's checks.
Each run leaves:

| File | Contents |
| --- | --- |
| `result.json` | exit code, dsh version, launch command, env (key redacted), watchdog command, every assertion with pass/fail, `passed` |
| `requests.jsonl` | one record per mock request: headers (key redacted), body, matched reply name, latency |
| `stdout.ndjson`, `stderr.log` | dsh `--json` run events and diagnostics |
| `home/sessions/**/session.v4.jsonl` | the session log the assertions read |
| `patch.yml`, `script.json`, `mock.out.log`, `mock.err.log` | inputs and mock diagnostics |

## Write a scenario

A scenario is JSON read by `run.mjs`. Two fields are mandatory and enforced: `perturbation`, the
one-line mutation that must make this scenario fail (a missing line is exit 2), and `expect` with at
least one assertion besides `exitCode` ("exited 0" alone is rejected).

```json
{
  "slug": "smoke",
  "task": "…one sentence…",
  "timeoutMs": 60000,
  "perturbation": "…what to break…",
  "workFiles": { "notes.txt": "…" },
  "script": { "title": "Rig smoke", "replies": [ { "name": "text-turn", "match": {}, "reply": { "type": "text", "text": "…" } } ] },
  "expect": { "exitCode": 0, "mock": { "mainRequests": 1 }, "session": { "assistantTexts": ["…"] } }
}
```

`workFiles` (optional) seeds the evidence work dir before launch; keys must be relative and stay inside
it. `scriptPath` and `projectionPath` are resolved relative to the scenario file.

Script matchers, first match wins, every present field must hold: `tools_length`
(`present` / `absent` / a number), `messages_length`, `tool_results_count`,
`last_assistant_tool_names` (exact ordered array; the tool_use names in the newest assistant message),
`body_text_contains` (string or array), `last_user_text_matches` (regex). No match is a loud 500 plus a
`no-match` log record — a silent default reply would make every gate green for the wrong reason.

Expectation blocks: `mock` (request shape, incl. `pruneRequests`), `session` (log
contents), `stdout`
(`finalText`), `tools` (`calls`, `results`, `failedResults`, `callIds`, `names`, `resultContains`,
`resultAbsent`, `finalText`), `prune` (the record-only pass's
journal records, below), `replay` (`scriptTurns`,
`minTurns`, `assistantTextsMatchScript`, `requestKeysMatchScript`).

## Determinism

`run.mjs --projection-out <file>` writes this run's canonical projection; `--projection-in <file>` (or a
scenario's `projectionPath`) asserts it equals a previously recorded one. The projection drops times,
ids, usage and absolute evidence paths, keeps the `(tool-result count, tool names)` request keys, the
assistant texts, tool call ids/names, tool result bodies and the session event order, and counts the
title request as 0-or-1 because it races process exit. A replay scenario with `projectionPath` therefore
fails if two runs of the same fixture disagree.

Reply types: `text`, `tool_use` (`calls: [{id, name, input}]`), `http_error` (with `status`),
`sse_error` (an `event: error` frame), `truncated` (ends before `message_stop`). The last three
exist so the failures the rig must prove are expressible.

The lanes, what names each one, and where its answer comes from:

| Lane | Named by (a fact about the request) | Answer source | Placeholders |
| --- | --- | --- | --- |
| `title` | the system prompt opens with `Create a concise title` (tested after the entry and table arms) | `script.title` | — |
| `entry` | the last user message ENDS with `[[entry-ask-end:3f8b2d71c04e4a9db6e05c17]]` (the body is untrusted: it embeds the result's bytes) | `answers.entry`, never `replies`; an object serves every ask, an array serves one reply per ask in order and the last repeats | `{{shapeAnswer}}`, `{{recallId}}` |
| `prune` | the body carries the table ask frame, or a tool-less ask ends with the prune final line; every table ask is this lane since ADR-0028, whatever its row count | first matching `replies` row | `{{tableAnswer}}`, `{{forgetallTableAnswer}}`, `{{recallId}}` |
| `compaction` | the last user message starts with `You are now acting as a compaction engine` | first matching `replies` row | `{{recallId}}` |
| `post-compaction` | the history carries the `<compacted-summary>` tag | first matching `replies` row | `{{recallId}}` |
| `main` | anything else that is not a title call | first matching `replies` row | `{{recallId}}` |

An `entry` ask is its own answer source because it embeds the result's own bytes: a body matcher could
route it to a main or table row. With no `answers.entry` the mock answers HTTP 500 `rig_no_entry_answer`
and logs `matched: 'no-entry-answer-scripted'`, never a fallback. The `kind: 'entry'` record also
carries the answer turn — `answer` is the exact text served, `answer_index` its queue slot — so an
offline harvest can join ask to answer without parsing SSE. Each lane is counted by its own expectation
(`mock.pruneRequests`), never by `mainRequests`; a prune row must come before
every main row, and `expect.prune` asserts the journal side (`planUnits`, `askIndices`, `noPublish`,
`surfaceOps`, …).

```json
{ "answers": { "entry": [
  { "type": "text", "text": "{{shapeAnswer}}", "shape": { "keepall": true } },
  { "type": "text", "text": "{{shapeAnswer}}", "shape": { "keeplines": [[2,3],"stale run notes"] } }
] } }
```

`{{shapeAnswer}}` must be the reply's whole text, and `shape` must be exactly one of the three entry
answers (ADR-0022 §9): `{"keepall":true}`, `{"forgetall":"…"}`, `{"keeplines":[[start,end],…,"summary"]}`,
the summary at most 25 words. The value is checked at script load, so `keephead`, a second top-level
key, a bad pair or an over-long summary refuses the script with a named rig error before any launch.

## A second launch (`/prune` and other whole messages)

A dsh headless process sends exactly one user message: the task. A whole-message command such as
`/prune` therefore needs a second launch that resumes the session the first one persisted:

```json
{ "secondLaunch": { "task": "/prune" } }
```

`secondLaunch` may also be an array of such objects; every entry resumes the same session id, in
order, so a scenario can spend three or more launches on one session.

After the first process exits, `run.mjs` reads the session id from the single persisted
`session.v4.jsonl` and spawns `dsh --profile headless --patch <same> --json --session-id <id> /prune`.
Every launch gets its own kill timer armed before the wait; `result.json` records `launches[]` with
each exit and watchdog, and launch 2 and later also get `launch-N.stdout.ndjson` / `launch-N.stderr.log`.
`mock.mainRequests` and the `tools` counts span every launch. N launches mount the plugin N times, so
a journal assertion that counts `mounted` lines states `racoons.mounted: N`.

The mount's round ordinal is persisted in the session directory, not held per process: a resumed
process reads the last ordinal from disk on mount (`prune-round-resumed`) and its first pass is the
next one. `scenarios/prune-apply-auto.json` is the proof — each of its three launches crosses and runs
one pass, so the ordinals are [1,2,3]. Two passes in one run are two launches, so `expect.prune.asks`
is the total answered tables while `asksPerPass` is the per-pass count (it defaults to `asks` for
single-pass scenarios); `tableUnits`, `planUnits` and `planAskRows` take a scalar ("every table") or an
array (one value per asked table, in order) so a per-pass count that legitimately differs can be pinned.

## Mount a racoons scenario

A scenario with a `racoons` block mounts the shipped `cremator-dsh/plugin` entry through a patch row the
driver writes. The block's keys are the entry's flat config; the driver adds `evidenceDir` and
`crematorStorageRoot`, and the entry opens its own per-session ledger under the latter — the wrapper
supplies no ledger, so the product's durable seam is the one under test:

```json
{
  "racoons": { "capBytes": 8192, "capHeadBytes": 2048, "episodeNoNewPathSteps": null, "barBytes": 2048 },
  "expect": { "racoons": { "capPlans": 1, "capEntries": 1,
                            "surfaceCapped": { "capHeadBytes": 2048, "bodyBelowBytes": 8192 },
                            "recallRestores": true } }
}
```

The storage root is always `<evidence>/racoons/storage`, or the scenario's own absolute
`crematorStorageRoot`; the real `~/.dsh` (`C:\Users\TZhen\.dsh`, other device `C:\Users\TZ\.dsh`) is
never touched. The driver derives the ledger path from the session directories the run left
(`<storage>/sessions/<id>/ledger.sqlite`), so a two-launch scenario proves the second process read
the first one's file. `expect.racoons` keys for that shape: `storageSessions` (directory count),
`durableStorage` (every `mounted` line says `ledgerSource: durable` with this root),
`recallToolRestores` (the `recall` tool's answer equals the origin bytes), `recoveryPending` (the
post-restart block on new removals, ADR-0004).

`capHeadBytes` must be set for any cap to fire: `CapRule` returns `null` when it is `null` (spec §1).
`episodeNoNewPathSteps` closes a search episode after that many steps with no new path; leave it
`null` and the episode closes at `turn/end` instead. `enforcement` defaults to `apply` (ADR-0008), and
`"record-only"` is the explicit opt-out. An applying verdict additionally needs a stated warm cache
watermark; the mount states `cache: unknown`, so it records the answer and refuses the cut (`NOTES.md` S5).

The compile step, the mount's seams and the Tier 3 lane are in `reference.md`.

## Verify a scenario is not vacuous

Per `docs/guides/law-verification-non-vacuity.md`: apply the scenario's own
`perturbation`, re-run, read the failure **by name**, restore, re-run green. A green run whose
perturbation was never tried is not evidence.
