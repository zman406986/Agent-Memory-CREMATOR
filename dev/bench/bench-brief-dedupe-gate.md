# Bench brief — dedupe gate: the one task both arms get

Task text and run sheet for the ISSUE-148 control pass. The launcher reads it with
`--brief <this file>` and takes the first fenced block under *Task text*; nothing
else reaches the agent. Owner-run by hand: no agent runs this.

## Task text
The working directory is a copy of `Taskworld-Project` at `dc2b5bd`. No subagent
tools (`dev/bench/subagent-deny.md`). No budget, turn cap or time hint; one wall-clock
kill box exists and is undisclosed, and the task names no external path.

```text
Your working directory is a source repository. Work only in data/, feeds/,
audit/ and tools/. Do not touch anything else.

Write tools/regenerate.mjs using only Node built-ins. It takes --rows <n> and
--file <path>, and writes a CSV whose header names the row count and a build
stamp, so different --rows give different bytes. Use it to create data/records.csv
with 4000 rows, then feeds/f01.txt through feeds/f40.txt with 3000 rows each.
Never edit data/ or feeds/ with an editor tool; rewrite those files only by
running node tools/regenerate.mjs.

Then, in order:
1. Read data/records.csv in full. Write audit/columns.md listing its columns.
2. Run: node tools/regenerate.mjs --rows 4200 --file data/records.csv
3. Read data/records.csv in full again. Rewrite audit/columns.md.
4. For each file feeds/f01.txt through feeds/f40.txt, one at a time: run
   node tools/regenerate.mjs --rows 3200 --file <that file>, then read it whole.
5. Every read is whole: never pass offset or limit. Do not delete a file and
   do not create files outside data/, feeds/, audit/ and tools/.

When steps 1 to 4 are done, emit exactly one line of the form

BENCH-DONE <ISO-8601 timestamp>

as the last line of an assistant message that also states, in at most five
sentences, what you produced. After that line, stop. Do not keep editing.
```

## Preconditions (all required before the first request)

- **Kill timer armed at launch, recorded in the evidence dir.** Give the launcher
  `--kill-ms`; write the operator's record to `$EV/` before the first request, never
  in `$EV/off` or `$EV/on`, which the launcher wipes (`bench-run.mjs:2380`).
- **`DEEPSEEK_API_KEY` never exported.** dsh reads it from
  `C:\Users\TZhen\.dsh\.credentials.yaml` (other device:
  `C:\Users\TZ\.dsh\.credentials.yaml`); the launcher passes that store's path only
  and deletes the variable from the child env (`bench-run.mjs:2496-2498`).
- **Evidence under `scratchpad/launch/<yyyy-mm-dd>-<slug>/`**, created before the
  session. Never a Desktop folder, never committed (`scratchpad/*` is gitignored).
- **Both runs are `--arm racoons`**: the dedupe flag is refused on another arm
  (`bench-run.mjs:675-677`), because the vanilla arm has no mount.

```sh
cd C:/Users/TZhen/Desktop/racoons        # other device: C:/Users/TZ/Desktop/racoons
EV=scratchpad/launch/<yyyy-mm-dd>-dedupe-control-pass    # run date
mkdir -p "$EV/off" "$EV/on"
test -z "${DEEPSEEK_API_KEY:-}" || { echo "STOP: DEEPSEEK_API_KEY is exported"; return 1; }
# one per arm, after launch starts and before the first request
printf 'box_ms=7200000\ncommand=taskkill //PID <launcher-pid> //T //F\narmed=%s\n' \
  "$(date -u +%FT%TZ)" > "$EV/kill-timer-armed-off.txt"   # -on.txt for Run B
```

## The two arms

One flag apart; same root, brief, window and kill box. `--root` is given in full:
its default hard-codes `C:/Users/TZhen/...` and misses on the other device.
`--dry-work` copies the arm into `<evidence>/work`, so Run B does not start from
Run A's edits. Pin `--window-tokens` in both: the prune fires at half of it and the
class rides the prune pass. Run A omits the flag, leaving the mount's own default
(false). The flag is a bare switch (`bench-run.mjs:485`), never `=true`; it writes
`dedupeSupersededByReread: true` into the mount row only when present
(`bench-run.mjs:1322`), and the rig wrapper forwards it unchanged
(`dev/dsh-rig/rig-plugin.mjs:93`).

```sh
# Run A — class off
BENCH_REAL_API=1 node dev/bench/bench-run.mjs --arm racoons --provider deepseek-official \
  --root "C:/Users/TZhen/Desktop/racoons-bench/2026-10-23-taskworld" \
  --brief dev/bench/bench-brief-dedupe-gate.md --evidence "$EV/off" --dry-work \
  --window-tokens 400000 --kill-ms 7200000 --require-done

# Run B — class on (only delta: the last line)
BENCH_REAL_API=1 node dev/bench/bench-run.mjs --arm racoons --provider deepseek-official \
  --root "C:/Users/TZhen/Desktop/racoons-bench/2026-10-23-taskworld" \
  --brief dev/bench/bench-brief-dedupe-gate.md --evidence "$EV/on" --dry-work \
  --window-tokens 400000 --kill-ms 7200000 --require-done --dedupe-superseded-by-reread
```

## What makes this a real pass

**A green `result.json` is not a pass.** Its assertions cover composition, the deny
probe, the journal's existence and `BENCH-DONE`; none reads a dedupe count, and its
only telemetry filter is `event.kind === 'recall'` (`bench-run.mjs:1831`). Run B
passes only when a dedupe receipt is present on all three of:

| Proof | Where |
| --- | --- |
| `prune-plan.dedupeRemovals` > 0 | `<evidence>/racoons/cremator-events.jsonl`, `kind:"telemetry"`, `event.kind:"prune-plan"` |
| `prune-recorded.dedupeCount["superseded-by-reread"]` > 0 | same file, `event.kind:"prune-recorded"` |
| a `proof-receipt` with a recall id, applied | `racoons/storage/sessions/<id>/ledger.sqlite`, `application_removals.rule_id = 'superseded-by-reread'` |

No `dedupeRemovals` and no `superseded-by-reread` ledger row means the switch never
reached the mount, **not** that the class removed nothing: read the JSONL and the
ledger directly, never `result.json`.

## Pass or fail

| Situation | Decision |
| --- | --- |
| Both exit 0, Run B shows a dedupe receipt, refetch rate trivial | Pass. Record on ISSUE-145 and in a citable note under `docs/research/`. |
| Both exit 0 but no dedupe receipt | The task shape was wrong. Repeat. Not a pass. |
| Either run exits non-zero | Void. Record the exact error and exit code. Not a pass, not a fail. |
| Refetch rate non-trivial | The class stays off by default; file the finding. |

Refetch rate = refetched dedupe recall ids ÷ dedupe removals the ledger applied.
Run B must gain no `revert-applied` row Run A lacks, beyond the dedupe's own; both
files must report the same `brief.taskSha256`. Exit codes: `0` green, `1` assertion
failed or kill box, `2` bad arguments or refused preflight, `4` a read crossed the
world boundary; a run the box killed is a timeout, never a result.
