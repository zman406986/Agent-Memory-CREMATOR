# dsh test rig — reference detail

The compile step, the mount's seams and the Tier 3 lane, moved out of `README.md` so both files stay
under the line cap. `README.md` says how to run what exists; this file is the detail behind it. The
binding plan is `archive/2026-10-22-dsh-test-rig.md`.

## The compile step

A dsh child process is plain Node: it neither strips types nor resolves the repo's `@cremator/core`
alias. `run.mjs` therefore calls `build-dist.mjs` before launch, which runs the repo's own `tsc`
against `tsconfig.rig-dist.json` and emits both packages to `scratchpad/dsh-rig/dist/`. It also writes
two `node_modules` shims in that tree (`@cremator/core`, `cremator-dsh`) that re-export the emitted
entry, so the adapter's bare import resolves with exactly one module instance.

The build is stamped by a hash over `tsconfig.rig-dist.json` and every source file it includes, so a
second scenario costs one hash and no compile. The dist tree and the stamp live under `scratchpad/`,
which is gitignored: no build output is committed. The wrapper reads the tree through
`CREMATOR_RIG_DIST`, which the driver sets on the child; when it is unset, `apply` refuses instead of
importing TypeScript sources.

## What the mount does at each seam

The mount is `packages/adapters/dsh/src/plugin.ts`; `rig-plugin.mjs` only loads it, routes its journal
and points `crematorStorageRoot` at a throwaway root under the evidence dir, so the entry's own durable
seam writes the per-session ledger. The seams, for reference:

| Seam | Mount action |
| --- | --- |
| `session/event` (`tool/call`, `tool/result`) | Records the call's name/arguments and queues the result. **Never appends**: the host throws when an append reenters its publication boundary. Only `surfaceOp: 'append'` results are captured, so the mount never re-caps its own replacement. A result with `message.isError: true` is journaled as `skip`/`failed-result` and never queued: failure is not a cappable result (S7). |
| `agent/pre-step` | Syncs the port's transcript from the surface prefix before each delivery, delivers each queued result through `adapter.onToolResult` (Cap), then runs `adapter.onPreStep` (Seal). |
| `agent/turn-stopping` | Runs the at-rest pass with `reason: 'turn-end'`, the last seal opportunity in a one-shot run (no pre-step follows). Uses the payload's agent, else the store's single live session, else it refuses. |
| publication | A Cap replacement re-appends the same `tool/result` with `surfaceOp: {op:'replace', startSeq, endSeq}` over one node. A Seal record becomes one `user/message` with `surfaceOp:'append'`. |
| tools | `recall` is registered once at mount through the host's `tools.register`; `forget` and `expand` have no handler in this build, so they are never offered. |

Every step is journaled to `<evidence>/racoons/cremator-events.jsonl` (`rig-mount`, `mounted`, `entry`,
`at-rest`, `publish`, `skip`, `telemetry`, and `*-error` lines). The driver's `expect.racoons` checks
read that journal plus the session log; ledger-side checks call `inspect-ledger.mjs` in a fresh process
against the closed database, so the recall leg is exercised as a later caller would exercise it.

Three host facts the mount compensates for, each found by a live run rather than assumed:

- dsh numbers `step` from 1 in every turn; the core wants one monotone step ordinal across the
  transcript, so the mount numbers each distinct `(turn, step)` pair.
- A turn is complete only at its `turn/end`, so `completedThroughTurnOrdinal` follows `turn/end`,
  never "current turn minus one".
- A one-shot run sends no request after its last step, so a seal that closes at turn end lands after
  the final request. "The next request carries the appended fact" is therefore a *later* run's
  observation (S4), not a claim this rig can make about the run that appended it.

## Tier 3 — one real API call (off by default)

A scenario marked as tier 3 (real API) and carrying no `script` drives the real route. It refuses to run
unless `RIG_REAL_API=1` **and** `RIG_KILL_TIMER_MS` (a positive integer) are set; a missing timer is
exit 2 before launch, and the timer replaces the `2 × timeoutMs` watchdog.

What differs from tiers 1–2:

- **No mock.** The mock server is never spawned, `requests.jsonl` stays empty, and an assertion fails
  if a mock log exists. `DEEPSEEK_BASE_URL` and `DEEPSEEK_API_KEY` are **absent** from the child
  environment, not blank.
- **The real `DSH_HOME`.** The credential store lives at `~/.dsh/.credentials.yaml` (other device:
  `C:\Users\TZ\…`) and only dsh may resolve the provider key from it. The rig never reads, prints or
  copies key material; the only thing it passes is the store's **path**, as `RIG_CREDENTIALS_PATH`.
- **One extra overlay**, `--patch <evidence>/tier3-patch.yml`: `credentials` re-enabled (headless
  disables it) and pointed at that path; `agent-default-model` moved to the real route's provider
  and model; that route restated (`api`, `baseURL`, `apiKeyEnv`, `maxTokens: 4096`); the
  `session-persistence-jsonl` and `storage-json` roots redirected into the evidence dir through
  `RIG_SESSIONS_DIR` / `RIG_STORAGES_DIR`, so the real session store is never written; and
  `session-title-llm` disabled (a second billed request that races exit).
- **`expect.realApi`** is the non-vacuity: a mock run cannot produce an `assistant/message` usage row,
  a `request/context` naming the route's provider and model, or a `read` tool call whose result carries
  the fixture text. It also asserts no record mentions `127.0.0.1`, the child environment carried no
  key, and the run stayed within `maxModelRequests` (spec §8's ≤3).

Apply the scenario's perturbation by adding rows to its own `patches` (they are appended last). The
cheapest one is zero-cost: `["- id: credentials", "  disabled: true"]` must fail with
`MISSING_CREDENTIAL` and produce no usage row — dsh dies before any request leaves the machine.

Measured 2026-10-22 (`dsh 0.2.1-rc.2`): exit 0 in 8.6 s, two requests, 246 output tokens total, the
answer named `port = 99999`. Evidence: `scratchpad/dsh-rig/2026-10-22-tier3-smoke/`.
