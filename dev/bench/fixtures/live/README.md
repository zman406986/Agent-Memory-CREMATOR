# `dev/bench/fixtures/live/` — the offline fixture, and where it came from

The Phase R v2 gate reads **this directory and nothing else**. `scratchpad/` is
disposable by law (AGENTS.md, shelf law), so a gate that read it would not be
reproducible on another device or after a cleanup. The transcripts here are
extractions of the two stored live records named below; the rows the converter
measures, keys or classifies are copied byte-for-byte.

Both source records are **gitignored working evidence**, never committed. This
directory is the committed form.

## Provenance

| Arm | Live record | Source path (this device) |
| --- | --- | --- |
| racoons | 040 live racoons, 2026-10-25, `a6-real` `deepseek-v4.1-flash-1017`; one live launch, exit 4 on a path-extractor false positive (see that record's `LAUNCH-RECORD.md`) | `C:\Users\TZhen\Desktop\racoons\scratchpad\launch\2026-10-25-040-live-racoons\worlds\racoons\evidence\sessions\--C-Users-AAAAA-Desktop-racoons-scratchpad-launch-2026-10-25-040-live-racoons-worlds-racoons-arm--\session-1308e8d8-c82d-41d3-81ef-05afddd24439\session.v4.jsonl` |
| vanilla | vanilla r2, 2026-10-24, same brief (`bench-brief-035.md`, sha `f5005171…` after the 2026-11-08 redaction; was `a3a1be40…`), `taskSha dd30a1a4…` (unchanged: the task fence was not touched) | `C:\Users\TZhen\Desktop\racoons\scratchpad\launch\2026-10-24-035-live-ab\bench-vanilla-r2\sessions\--C-Users-AAAAA-Desktop-racoons-scratchpad-launch-2026-10-24-035-live-ab-arms-vanilla-arm-r2--\session-d7f1af3f-b94b-43d5-8355-2f827cb8eec3\session.v4.jsonl` |

Second device (`C:\Users\TZ\…`): the same paths with `C:\Users\TZhen\` replaced
by `C:\Users\TZ\`.

The arm roots the join normalizes against are the two `…\arm` directories those
records ran in, and are recorded in `manifest.json.arms.<arm>.armRoot` — the
converter reads them from there, so the join's `<ARM>` substitution is stated
data, not a constant in code.

## Files

| File | What it is |
| --- | --- |
| `extract-fixture.mjs` | the builder — reads both records, trims, writes the three files below |
| `racoons.session.v4.jsonl` | 040 racoons, trimmed |
| `vanilla.session.v4.jsonl` | vanilla r2, trimmed |
| `manifest.json` | provenance: source path, arm root, session id, row counts, per-arm trim counts, per-file sha256 |
| `sha256.txt` | `sha256sum`-format lines over the three tracked files |

Regenerate with:

```
node dev/bench/fixtures/live/extract-fixture.mjs \
  --racoons <040 session.v4.jsonl> --vanilla <vanilla r2 session.v4.jsonl>
```

The generated files are byte-identical on a re-run from the same sources; the
gate proves that separately by running the converter twice into fresh output
directories and comparing file lists and hashes.

## What was trimmed, and why it cannot change a reading

Kept byte-for-byte: every `tool/result` body at or above **1 280 bytes** (this
model's shipped floor, the lowest floor the gate tests), every `surfaceOp`
replace row, every `tool/call` row, every `user/message`, and `session`,
`turn/start`, `turn/end`, `step/start`, `step/end`, `compaction/prune`.

Trimmed: `tool/result` bodies **below** 1 280 bytes keep their first 120
characters (still below every tested floor, so no classification changes);
`assistant/message` text becomes one fixed line and its `data.stream` chunk log
is dropped (3.1 MB + 2.7 MB of the two records; no reader of this pipeline
touches a stream chunk — `data.usage` is kept, because `askRows` reads it);
`system/message` text becomes one fixed line.

Dropped whole: `permission/preset`, `sandbox/mode`, `approval/policy`,
`agent/inbox/spliced`, `job/registered`, `job/settled`, `request/header`,
`request/context`, `session/title`, `todo/write`, `llm/retry`,
`llm/retry-started`, `assistant/attempt`,
`session-log-deepseek/delivery-accepted`. The exact counts per arm are in
`manifest.json.arms.<arm>.trim`.

**A floor below 1 280 B is refused by name** (`fixture-floor-below-keep`)
rather than scored: bodies in [120, 1 280) are short copies here, and scoring a
copy as if it were the landed bytes would be a fabricated reading.

## The census the fixture must reproduce

Both records carry one user turn, so the pins below are the whole of §1's
transcript census:

| Fact | racoons | vanilla |
| --- | --- | --- |
| `tool/result` rows · `append` · prune-paired `replace` | 201 · 186 · 15 | 187 · 177 · 10 |
| landed (`append`) rows ≥ 1 280 B | 65 | 56 |
| landed rows ≥ 8 192 B (the old bar) | 17 | 12 |
| steps | 98 | 133 |
| `assistant/message` rows (the `askRows` input) | 98 | 133 |
| `compaction/prune` rows | 15 | 10 |

`askRows = #(assistant/message) − #(step/start)` is **0** on both arms: neither
log carries an ask-fork usage row, so any ask total in a later chunk is a
labelled projection, never a measurement.

## Known limits of the fixture

- `assistant/message` text is a placeholder, so an answer is never present. The
  converter therefore classifies composition from **surface events** (the
  atomic replace rows) plus the ledger, never from an answer's text — which is
  what the corrected protocol requires anyway.
- The ledger is **not** in this directory. `040`'s per-session
  `ledger.sqlite` records 3 `ledger_events` and 0 `application_removals`
  (the engine's judge breaker disabled itself 8 steps in, so nothing was
  removed). The metric producer accepts a ledger path and reports
  `no-ledger-row` for a unit with no row; the fixture gate runs without one and
  prints that class, so the path is exercised rather than assumed.
- No `ask` turn exists in either record: both live runs predate the corrected
  protocol's ask seam, so every over-floor unit classifies as
  `ask-failed-fail-open` (over-floor landed row with no ask turn after it). That
  is the honest reading of these two records, and it is exactly the class the
  plan calls a finding when nonzero.
