# Running the spend alarm beside a live bench run

`dev/bench/token-alarm.mjs` is a read-only meter. It kills nothing and the bench does
not know it exists. It prints three numbers per poll, and exits 3 when the true total
crosses `--stop` so a shell can act on it.

This file is the operator's half. The meter's own header states what it reads and why.

## 1. What the three numbers are

| Number | Read from | Meaning |
| --- | --- | --- |
| MAIN | every `session.v4.jsonl` under the target, `assistant/message` rows | billed prompt main paid: `inputTokens + cacheReadTokens + cacheWriteTokens` |
| ASK | `<evidence>/racoons/cremator-events.jsonl`, the `usage` field of `entry-ask`, `entry-ask-refused` and `prune-ask` | billed prompt the mount's ask forks paid, one entry per ask |
| TRUE | MAIN prompt + MAIN output + ASK prompt + ASK output | the total the money is spent on, and the total the grant compares |

The prompt parts of both lanes add; TRUE also adds each lane's output tokens, the same
four streams `computeTrueTotal` sums for the in-run watchdog.

**Two things TRUE does not include, both stated on the line when they apply:**

- **A missing journal.** The line prints `ask n/a (no journal)` and `TRUE >=`, because
  an unread ask lane is not a spend of zero. On a racoons arm the journal appears when
  the mount writes its first event; if it never appears, that run has no ask lane
  measured and `--ask-journal` is the flag to point at the file.
- **A prune table with no cost row.** Since ISSUE-178 the bulk prune writes one
  `prune-ask` record per table send and one per correction turn. A journal written
  before that change has no such row, so its tables are counted and named as
  `[N prune table(s) unmeasured]` rather than folded into ASK as a zero.

## 1a. What the bulk prune lane reports, and what a reading means

`prune-ask` carries the same `usage` object the entry lane writes — `inputTokens`
(the whole billed prompt: host input + cacheRead + cacheWrite), `outputTokens` and
`cachedInputTokens` — plus `round`, `tables`, `status` (`answered` / `refused`) and
`retried` on the correction turn. `tables` is the ordinal of the send, so two tables
of the same size stay two readings; the meter never collapses them.

## 2. Invocation

Run it in a second terminal, started **after** the bench launcher has created the
evidence dir (the launcher wipes that dir at start, and the alarm drops a tail whose
file was deleted — but starting after the wipe is simpler than relying on it).

```bash
# the evidence dir form — the launcher's own layout, journal found automatically
node dev/bench/token-alarm.mjs <world>/evidence --warn 80000000 --stop 100000000

# the session-log form — walks up from the log to the same evidence journal
node dev/bench/token-alarm.mjs <world>/evidence/sessions/<dir>/<session>/session.v4.jsonl

# the journal by hand, when it is not where the layout puts it
node dev/bench/token-alarm.mjs <evidence> --ask-journal <path>/cremator-events.jsonl

# one reading and exit — the check before a run is trusted
node dev/bench/token-alarm.mjs <world>/evidence --once

# prove the meter itself, no session and no spend
node dev/bench/token-alarm.mjs --selftest
```

`<world>` is the directory the launcher was given with `--world`; its layout is
`<world>/arm` and `<world>/evidence` (`dev/bench/launch-contract.md`). Both devices:
`C:\Users\TZhen\Desktop\racoons\...` and `C:\Users\TZ\Desktop\racoons\...`.

Exit codes: `0` a reading or a clean operator stop, `3` TRUE reached `--stop`, `2` bad
arguments or an unreadable target. These are the alarm's own; none of them is a bench
outcome.

## 3. What `--token-grant` takes

`--token-grant` is the launcher's kill, and it meters the same TRUE total the alarm
does: main prompt + main output + ask prompt + ask output. Pass the cap itself. No
conversion, and none of the old main-only numbers are grant values.

The old main-only rule converted a TRUE cap with the measured ask/main ratio **0.903**
(2026-10-29 racoons arm: 57 803 506 ask prompt tokens over 63 960 657 main) plus a
**0.05 reserve** for the bulk prune, which that run never journaled, so `TRUE <= MAIN
× 1.953`. Its grant levels were 40 900 000 / 51 200 000; under the TRUE grant those
numbers would kill at 40.9 M / 51.2 M TRUE, about half the intended spend. Do not pass
them.

```bash
node dev/bench/bench-run.mjs --arm racoons --provider deepseek-official \
  --token-grant 100000000 --kill-ms <ms> ...
node dev/bench/token-alarm.mjs <world>/evidence --warn 80000000 --stop 100000000
```

Both instruments read the same total: the grant is the cap you pass, and the alarm's
`--warn`/`--stop` stay at **80 000 000 / 100 000 000**.

**Once a run journals `prune-ask` rows, that run's ASK already includes the prune lane.**
The reserve is then only a margin on a reading; it never changes the grant, which is
the TRUE cap itself.

### How much confidence the ratio carries

**One run, and it omits the prune lane.** It is the maximum of the three recorded racoons
runs on this task. None of the three journals a `prune-ask` row — the ask was paid for
and never written down — so every ratio below is an entry-lane ratio, and every true
total below is a floor:

| Run | Main | Ask (entry lane only) | Ratio | Prune fires |
| --- | ---: | ---: | ---: | ---: |
| 2026-10-29 full rerun (run C) | 63 960 657 | 57 803 506 | **0.903** | 2, 2 tables |
| 2026-10-29 full rerun redo | 59 407 517 | 46 317 176 | 0.780 | 2, 1 table |
| 2026-10-28 extended | 46 638 185 | 27 741 876 | 0.595 | 0 |

Read 0.6-0.9 as the entry-lane band, not the total. Four consequences:

- The prompt total at a given main number has a wide band, and every point in it moves
  UP by the prune lane, which the three runs did not record. At main 50 000 000 the
  observed entry-only prompt range runs from 79 750 000 to 95 150 000; with the 0.05
  reserve it is 82 250 000 to 97 650 000. Both lanes' output tokens sit outside these
  figures; TRUE adds them.
- 0.903 is the highest observed entry-lane ratio, not a proven ceiling of the total.
- The prune lane is small beside the entry lane on these runs — two fires, one or two
  tables each, each about 200 000 tokens — which is why 0.05 covers it. A run whose
  prune fires far more often moves that bound, and the meter's
  `[N prune table(s) unmeasured]` is what says so.
- The ticket count, prompt and task shape move the ratio. All three runs above are one
  task on one model.

**The true multiplier is therefore unknown.** 0.903 is a floor on the ask/main ratio:
it is what the entry lane alone spent against a main reading, and the bulk prune's lane
was invisible when it was computed. The multiplier still says how far an entry-lane-only
ASK understates TRUE, but it converts nothing for the grant, which is the TRUE cap
itself.

So the grant and the alarm both meter TRUE, and the alarm is still the live view: watch
it. The grant is the backstop that kills from inside the launcher when no alarm is
running.

## 4. What the operator does

1. Set `--token-grant 100000000` on the launcher.
2. Start the run.
3. Start the alarm in a second terminal on the same evidence dir.
4. Read the `WARN` lines. At `read ` with `ask n/a`, confirm the mount is the wrapper
   (a `--plugin-entry` naming the shipped entry removes the journal sink).
5. On `STOP`, stop the run by hand if you want a clean end; the alarm itself will not.

Step 5 is the whole safety story: **the alarm is advice and the grant enforces the same
TRUE total.** A TRUE total past the grant with the run still going means a poll has not
landed yet, or a lane could not be read — not that the grant meters a smaller number.
