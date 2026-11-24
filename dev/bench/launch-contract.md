# The launcher's contract — exit codes, deny-leg scoring, the read boundary

Binding tickets: ISSUE-038 (exit codes), ISSUE-039 (read boundary). This file is
the one home for what `dev/bench/bench-run.mjs` guarantees a run; `runbook.md`
says what to run and links here. Two files, one fact each — never restate a row.

## Exit codes

| Code | Meaning | Exercised by |
| --- | --- | --- |
| 0 | green: every assertion passed, probe `pass`/`expected`/`skipped` | Step 2 clean mock; Step 3 real arm |
| 1 | a failed assertion, or a stopper fired | any red row; a box or grant hit is a **timeout**; `--stop-on-compaction` is a **landmark**, same code, name `stopped-on-compaction` |
| 2 | bad arguments, a refused preflight/replay map, or a non-isolated `--world` | a typo'd flag; an unbound map; the bad-world probe |
| 3 | mock lane only: the deny probe is `partial` after every arm assertion passed | Step 2 with a script that never summons |
| 4 | a `tool/call` named a path inside the campaign but outside the arm's world | the read-boundary probe |

A non-zero exit prints `EXIT=<n> (<name>)` on stdout and names the cause on
stderr. The order of decision is the defect fix: kill box → arm assertions →
out-of-scope read → mock-lane probe. A failed arm is never masked by a probe
outcome, and a probe outcome is never reported as an arm failure.

## The three stoppers (ISSUE-182)

The box (`--kill-ms`) and the grant (`--token-grant`) are budgets; `--stop-on-compaction` is a
landmark. All three kill the tree through the same `taskkill /PID <pid> /T /F` path and all three
take exit 1, because a killed run is never a result. The label tells them apart:

| Stopper | `result.json.watchdog` | other `result.json` keys | stdout name | stderr |
| --- | --- | --- | --- | --- |
| kill box | `fired: true` | — | `assertion-failed` | `FAIL: the kill box fired after N ms` |
| token grant | `tokenFired: true`, `trueTotalTokens`, `observedPromptTokens` (main-prompt component), `firedAt` | `stoppedBy: "budget"`, `stoppedByBudget: true`, `stop` (`reason: "budget"`, `censored: true`, `exitName: "stopped-by-budget"`, `exitCode: 1`, `budget` with `grant`/`trueTotalTokens`/the four streams/`askKnown`/`askComplete`/`polls`/`firedAt`/`killLanded`, `benchDone`, `deliverablesCreated`, `largestCheckpointReached`, `largestCommonK`, `peak`, `compaction`, `journalTotals`, `askLane`, `note`) | `stopped-by-budget` | `FAIL: the token grant fired at N true tokens (main-prompt component M; grant G) after P poll(s)` |
| `--stop-on-compaction` | `stopOnCompaction: true`, `compactionFired`, `compactionStoppedAt {seq, step, turn, billedPromptTokens, compactions, firedAt}` | `stoppedOnCompaction: true`, `compactionStop` (+`killLanded`), `passed: false` | `stopped-on-compaction` | `STOPPED ON COMPACTION: first compaction/start at seq … (step …)` |

Exit 0 is deliberately not used: it means "completed and every assertion passed", and a stopped run
did neither. Exit 1 rather than a new code keeps the documented range at 0–4 and keeps the one rule
that a killed run is never a result. The stop keys exist only when the flag was passed, so any
existing run's `watchdog` object and exit code are unchanged.

`compactionStop.killLanded` states whether the `reap` found a live child. It is `false` when the
child had already ended and the row was written at its own end (the mock-replay lane does this,
because its record ends at the compaction), so the record never claims a kill a run did not need.
The label and the exit code are the same either way: the landmark is real, and a stop is not a
completion.

Two assertion rows cannot be scored on a stop run, and one row replaces them: `exit code` (the
child was killed, so there is no task exit to compare to `--expect-exit`) and, under pressure,
`pressure: compaction agrees with the recorded pressure` (its start/end pairing branch). The
replacement row compares the stop's `seq` and the compaction count to the session log, which the
post-run reader parses independently. Everything else still runs.

## The official-endpoint opt-in (ISSUE-176, ruling 2026-11-05)

The guard from ISSUE-176 stays, and the owner can now opt in by name. The default is still
closed: `--allow-official-spend` is absent from every command that does not type it, and a route
that reaches `api.deepseek.com` is refused without it. The flag is derived, not a provider list:
`officialRouteFor()` reads `REAL_ROUTES[provider].baseURL` and returns a route only when its
hostname is `api.deepseek.com` (today `deepseek-official` and `deepseek-v4-pro`).

| Without the flag | With the flag |
| --- | --- |
| a live official run exits 2 before the evidence dir is wiped, naming `--allow-official-spend` | `patch.yml` omits the official-row block, so the base rows stay enabled |
| `--preflight` writes the closed `patch.yml`, prints `official-route-provider=… spend=REFUSED`, then exits 1 with `preflight FAIL` | `--preflight` prints `spend=AUTHORIZED (--allow-official-spend: owner authorization 2026-11-05)` and passes |
| all six official rows stay disabled (`web`, `web-search-deepseek`, `web-deepseek-api`, `tool-web`, `llm-deepseek`, `llm-deepseek-account`) | those rows may mount, including `web_search`/`web_fetch` and the second deepseek adapter |
| no authorization is recorded, because no such run starts | `launch.json` and `result.json` carry `officialRoute`: `provider`, `endpoint`, `apiKeyEnv`, `spend: "authorized"`, `authorizedBy: "--allow-official-spend"`, and the ruling line |

On the mock lanes the flag changes nothing: their base URL is not the official host,
so the rows compose exactly as before and no `officialRoute` block is written. `BENCH_REAL_API=1`
is still required for a live call on any real route.

## The deny probe: arm outcome vs probe outcome (ISSUE-038)

Leg A reads the request header: a header that offers any of the six denied names
is a **hard** failure on every route. Leg B reads what happened to the summon,
and its score depends on the route:

| Leg B | Route | `denyProbe.legBOutcome` | `result.json.passed` | Launcher |
| --- | --- | --- | --- | --- |
| `pass` | any | `pass` | unaffected | continues |
| `partial` | `mock`, `mock-replay` | `probe-fail` | stays `true` | exit 3 |
| `fail` (a summon that did not fail as specified) | any | `fail` | `false` | exit 1, named |
| skipped | `mock-replay` | `skipped` | unaffected | continues |

Why `expected` on the real route: the bounded brief never mentions a subagent,
so a real model has no reason to summon one. Round 1's `SUMMARY.md` item 3 says
so, and Run B's racoons arm is that shape exactly (child exit 0, `BENCH-DONE`,
13 assertions / 12 pass, launcher exit 1 — the masking this removes). A
`partial` probe therefore cannot turn a completed arm red, and it cannot mean
"the deny surface is green" either: it is recorded by name in `result.json` and
in `deny-probe.txt`. The mock lane keeps exit 3, where the scripted summon was
mandatory and its absence means the probe measured nothing.

`legBOutcome()` and `exitCodeFor()` live in `dev/bench/launch-outcome.mjs`;
`dev/bench/launch-outcome.test.mjs` exercises every row above.

## The read boundary (ISSUE-039)

Run B's racoons arm read the other arm's `derive-vanilla.json` and the
campaign's `build/VERDICT.md` in one `pwsh` call (step 34, seqs 303/306) from an
evidence root one directory above the arm. The launcher bounded writes in prose
and reads nowhere. Two layers close it, and the launcher uses both.

**1. Layout — `--world <dir>`.** One directory holds this arm's tree, this arm's
evidence, and nothing else: `<world>/arm` and `<world>/evidence`. The launcher
refuses to start (exit 2) when the world root already carries a `build/` tree, a
`VERDICT.md`, a `derive-*.json`, or another arm's evidence dir. That refusal is
the shape Run B launched into: `$EV/arms/<arm>-arm` and `$EV/bench-<arm>` shared
one root, so `..` reached everything.

**2. Detection — the `read boundary` assertion.** Every `tool/call` in the
session log is scanned for the paths its arguments name: absolute drive paths
inside `pwsh` command strings, forward and back slashes, and `..` tokens resolved
against the child's cwd. Four buckets:

- **inside** the arm's world — fine.
- **allowed** — under `--allow-read <dir>` (repeatable) for a read, or the OS
  temp dir. An allow-listed operator root is READ-only: a `write`/`edit` naming
  one is a **violation**, not a permitted call. The brief's one sanctioned
  sibling, the template checkout, goes here.
- **violations** — inside the campaign (the world's parent, or the parent of a
  `worlds/` collector) but outside the world. The run fails: exit 4, the call
  named on stderr and in `result.json`'s `readBoundary.violations`.
- **outside** the campaign — a machine path. Recorded under
  `readBoundary.outside`, not gated.

Why the campaign line and not a machine-wide deny: `..` cannot be made
unreachable on Windows without a path sandbox, and dsh 0.2.1-rc.2 has none
(`subagent-deny.md`: `ToolRestriction` filters tools, not paths). The campaign is
the tree that decides A/B validity, so that is where the gate sits; a read of
`C:\Windows` is recorded so a reader can see the surface without failing a sound
run.

**Derivation stays outside every world.** `derive-*.json`, `build/` and
`VERDICT.md` live at `$EV/`, never under `$EV/worlds/<arm>/`.

**What the gate cannot see:** a `cd <dir>` followed by a relative path, and a
path assembled at runtime from shell variables. It turns a silent contamination
risk into a recorded one; it is not a sandbox. `read-boundary.mjs` carries the
same statement at the top.

`worldLayoutViolations()` and `classifyToolCalls()` live in
`dev/bench/read-boundary.mjs`; `dev/bench/read-boundary.test.mjs` covers the
layout refusal, the step-34 shape, `..` resolution, case folding, and the
read-only allowance.
