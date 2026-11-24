# Synthetic pressure — making the compaction row measurable on replay

Companion to `dev/bench/runbook.md` and `dev/bench/reference.md`. This file is the
one home for `--inflate-bytes`: what it does, why each part exists, and the proof
it works. Read it when you are about to run a mock replay to measure compaction,
or when you doubt a compaction number a bench run reports.

## Why the mode exists

A mock replay of a real record spends little context. The 41-reply record
(`dev/bench/replay-map/2026-10-23-dcb70387-scan-memoization.json`) peaks near
200 KB per request, roughly 5× under the host's compaction trigger, so both arms
showed zero compactions and the row measured nothing. The record cannot be made
longer (it is the longest blocker-free record on this device), and the host's
caps cannot be lowered without changing the product under test. So the bench
inflates the record's own tool results instead — and says exactly that.

> **synthetic pressure measures the cap/compaction MECHANISM under load, not
> real-record economics.**

## What the flag does

### 1. It pads the scripted shell calls

The mock scripts assistant turns, not tool results: a result is whatever the
host's tool returns when it executes the scripted call. For this record every
call but three is `pwsh`, so the honest lever is the command text. Each shell
call's `command` gains a deterministic ASCII loop AFTER the recorded output:

```powershell
; 1..N | ForEach-Object { '[synthetic pressure row ' + $_ + ']' }
```

with `N = ceil(minBytes / 25)` (`[synthetic pressure row k]` plus its newline is
25 bytes). Two runs with the same flag serve byte-equal commands, and therefore
byte-equal scripts. Only `type: 'tool_use'` replies holding a `pwsh`/`bash`/`sh`
call move; text replies, the prune prefix, the compaction lane and the
terminator are untouched, and the recorded command still runs before the filler.

### 2. The host's pruner is off on the racoons arm

This is the part that is easy to get wrong. `compaction-basic` does not fire on
pressure it can trim away: at confirmed pressure it calls
`toolResultPruner.pruneSession()` and re-measures, and only compacts if the
conversation is STILL over the trigger (`dsh-compaction-basic/lib/index.js`, the
`if (prune !== void 0)` block). A conversation whose pressure came from tool
results is rewritten to ~5,150 chars per result — 63 results ≈ 81k tokens — and
drops back under the trigger, so summarization never runs. The pruner is doing
its job; it also makes the row vacuous for exactly the pressure this mode
injects.

The state is arm-dependent (ADR-0055). The racoons arm writes
`- id: tool-result-pruner` / `disabled: true` into `patch.yml`, because the
pruner is a competing mechanism and the mount must be the only remover
(ADR-0041); the row this mode measures is therefore `compaction-basic` alone.
The vanilla arm writes no row: it prices the host as shipped, so its pruner stays
on and trims this mode's injected pressure, leaving its compaction row vacuous.
`--allow-host-pruner` (or its older spelling `--end-pressure-isolation`, which
still needs `--inflate-bytes`) is the racoons arm's opt-out and a no-op on
vanilla; a racoons run that takes it is not a product measurement. The patch text
is the INTENT; the gate judges the COMPOSED config instead — `dsh --dump-config`
is run over that patch before the arm starts, its output is kept as
`<evidence>/dump-config-host-pruner.yml`, and `result.json.hostPruner` records the
arm's state, the composed-config read-back and the session log's
`compaction/prune` count. On the racoons arm a dump with one still-enabled copy
of the row fails the gate, and any `compaction/prune` event fails a run whose
pruner was meant to be off.

### 3. It serves the host's compaction lane

The summarization ask is an ordinary request: it keeps the conversation's tools
and appends its instruction as the final user message, so it is neither a prune
table ask nor a main turn. Without a reply it is a mock `no-match` (500),
the compaction fails, and the arm ends on a provider error. The mock therefore
classifies it (`kind: 'compaction'`, named by the instruction prefix) and answers
from a fixed row; the first request after a checkpoint is classified
`post-compaction` and answered by its own row, because the checkpoint replaces a
span and the tool-result count no longer follows the record.

Both lanes are replay-external, exactly like the prune prefix: `mainReplies` drops
them, so "every scripted reply was consumed", the request-key gate and
`--perturb-swap-match` numbering still count record rows only. `mock.compaction`
and `mock.postCompaction` count the asks from the wire.

The lane set is closed, and no row count decides anything in it. `classifyRequest`
reads the entry arm first (only that ask ends with its anchor), then the table
arm; a table ask is the bulk prune alone, so a 1-row table — the normal tail of a
pass — is the prune lane exactly as a 12-row one is. The title arm, the tool-less
prune final line, the compaction and post-compaction arms and `main` follow, in
that order. There is no judge lane and there are no judge rows: ADR-0028 retired
the judge pass along with the tool-less decision-line arm that used to read a
3-row table as something other than a prune.

## What the run records

| Key | Meaning |
| --- | --- |
| `syntheticPressure` | `enabled`, `minBytes`, `fillerLines`, `paddedResults`, `delivered{min,median,max}`, `honesty`, `isolation{row,requested,ended,applied,source,composedRows,disabledRows}` (the same state `hostPruner` states for every run since ADR-0041) |
| `hostPruner` | `row`, `disabled`, `optOut`, `composed{applied,source,rows,disabledRows}`, `pruneEvents`, `pruneShadowedTokens`, `asserted` (recorded on EVERY run, padded or not) |
| `context` | `series` (bytes per conversation turn), `peak`, `peakRequest` (1-based), `final`, `turns`, and two INFORMATIONAL token rows: `trigger{tokens,meter:'host'}` and `peakBytesEstimate{tokens,bytesPerToken}` |
| `compaction` | `count`, `atRequests` (1-based turn the start preceded), `atSeqs`, `ends`, `pruneEvents` |
| `mock.compaction`, `mock.postCompaction` | the host's asks, counted from the wire |

`context.series` is `body_bytes` from `requests.jsonl`: the raw request body, so
it is a byte measure of what the model saw, not an estimate from the script.
Title, entry, prune and compaction asks are excluded — the series describes
conversation turns, and folding a harness ask in would make the peak describe a
request no turn made. `compaction.count` counts `compaction/start` in the session
log; `pruneEvents` is the pruner's own `compaction/prune`, kept separate because
a trim is not a compaction.

The two token rows are for a reader, never for a gate. `trigger.tokens` is the
host's figure on the host's own meter (`meter: 'host'`); `peakBytesEstimate` is
`peak / 4`, and it UNDERSTATES that meter — a vanilla arm compacted while its
byte estimate read 674,043, under the 678,464 trigger. So no assertion compares
a byte count to the trigger: a healthy arm would false-fail. The compaction gates
read the recorded event count and the context series, nothing else.

Both are recorded for every mock-replay run, mode or no mode: the measurement is
the same, it just does not reach the trigger without the flag.

## The trigger is 678,464 tokens, not 800,000

`compaction-basic` fires at `floor(min(W × 0.8, W − O − B))` with:

| | value | where it comes from |
| --- | --- | --- |
| `W` | 1,000,000 | the `deepseek-flash` adapter's `DEFAULT_CONTEXT_WINDOW` |
| `O` | 256,000 | the request envelope's `maxTokens`, which the header reserves |
| `B` | 65,536 | `headroomTokens` |

`min(800,000, 678,464) = 678,464`: the completion reservation binds before the
ratio does. `bench-run.mjs` states this as `PRESSURE_TRIGGER_TOKENS` and records
it in `result.json` as `context.trigger` with `meter: 'host'` — information, not
a threshold any assertion uses.

The gate deliberately does NOT recompute the host's token measure from bytes. The
meter prices content blocks, per-message framing and a routed baseline, so
`body_bytes / 4` is an estimate in a different unit from the trigger's, and it
reads LOW. What the gate checks instead is what the artifacts can prove: a
compaction that opened also closed, it names a turn inside the run, and the
context after it is smaller than the peak. A compaction that leaves the pressure
in place is the failure the mode exists to catch. A run that records zero
`compaction/start` is reported as a measurement — the peak and the turn count,
never a verdict about whether the host should have fired.

## Delivered size is not the requested size

The host caps a tool result before the model sees it: spill-policy
`maxInlineTokens` 12,500 (≈ 50,000 chars) at post-execute, and the `read` tool's
50 KiB. At `--inflate-bytes 80000` the delivered median was 49,932 B on vanilla
and 12,465 B on racoons (racoons' own 8192-byte cap lands first, then the mount's
cap marker). `syntheticPressure.delivered` records what the model actually saw,
beside `minBytes`. A run whose filler was clipped is measuring the caps as well
as the compaction, and the artifact says so.

## Proof (2026-10-23, the 41-reply record, `--inflate-bytes 80000`)

That run used the old both-off shape: the pruner was disabled in both arms under
ADR-0041 decision 1 as then written. Under the current ADR-0055 shape the vanilla
arm keeps the host pruner at the host default, so its column below is that old
run's, not today's vanilla arm.

| | vanilla | racoons |
| --- | --- | --- |
| exit | 0 | 0 |
| conversation turns posted | 29 of 41 (cut by the compaction) | 41 of 41 |
| peak context | 2,696,170 B at request 28 | 721,275 B at request 36 |
| final context | 606,841 B | 702,372 B |
| `compaction/start` | **1**, before request 29, closed | **0** |
| `pruner-events` | 0 | 0 |
| tool-result caps (`capArchives`) | n/a | 63 |

In that run vanilla crossed the trigger and the host condensed; racoons'
8192-byte cap keeps every result small, so it never gets there and the record
plays to its end. That is the mechanism contrast, measured — never a claim about
which arm is better on a real task.

## Determinism

Two racoons runs with the same flag produced a byte-identical projection (8 keys,
41 requests, 63 calls, 0 failures). That is a WITHIN-MODE claim, and one key
needs stating plainly: `script_sha256` IS a projection key, and inflation moves
it, because the filler sits inside each scripted shell command's text in the
served `script.json` (padded `3eab6ff7…`, unpadded `540a8a5c…` on the 41-reply
record). So a padded projection is never compared to an unpadded one; the two
are different scripts. The other seven keys — the matcher keys, reply names,
tool-call names and failure counts — do not move with inflation, because they
never carry result text. `reference.md` § "The projection" states the same rule:
`script_sha256` is a determinism gate for one mode, not a cross-mode comparison.

A no-pressure run of the same record is also unchanged by this mode: the prune
prefix is untouched and the compaction lane is served on EVERY replay run, with
or without the flag. A real record can compact on its own, so the lane is a fact
of the host, not of this mode; without pressure no request has its shape, so the
rows are inert and cost nothing.

## Limits, stated

- **A padded run's compaction is what the host does with its pruner ABSENT.** The
  pruner would trim exactly this injected pressure before `compaction-basic` ever
  summarizes. The racoons arm mounts that configuration (ADR-0041); the vanilla
  arm keeps `tool-result-pruner` on at the host default (ADR-0055), as production
  does, and would trim instead. So a padded racoons run's compaction is a
  measurement of the compaction mechanism, and the synthetic table must never be
  quoted as a production delay ratio.
- It measures the MECHANISM. Real records reach the trigger by their own content;
  this one reaches it because a synthetic command printed 3.2 MB. No economics
  claim follows from a padded run.
- The padding is per shell call, so the per-request context grows by roughly
  `calls_per_turn × delivered_bytes`. It is a step function, not a smooth ramp,
  and it will overshoot the trigger on the turn it crosses.
- A compaction cuts the record. That is the host's behaviour, not a bench
  defect: the run records how far the record played and the record gates assert
  the completed prefix, so a skip or reorder before the cut still fails.
