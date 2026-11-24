# `dev/bench/fixtures/runb/` — run B's frozen decision set

ISSUE-059 DoD item 5, first half. This directory holds the stage-1 mint of run B: one row per
landed result over the 1 280-byte floor, with the decision the run itself recorded. It is the
file stage 2 reads and scores. The working copy was under `scratchpad/`, disposable by law, so it
could not be cited; this is the committed copy. It is the mint's bytes after a byte-preserving
redaction: private project names and the owner's home path became same-length placeholders, so
every byte count and the 60-row census hold; the mint's own hash is kept below for provenance.

## Files

| File | What it is |
| --- | --- |
| `minted-set.jsonl` | the frozen set: 60 rows, keys exactly `{source, original, decisions}` |
| `sha256.txt` | `sha256sum`-format line for the row file, taken as it sits on disk |
| `.gitattributes` | `* text eol=lf`; the hash is over bytes, so a CRLF checkout would void it |

## What the census says

60 rows, 46 of them carrying a decision (`decisions` is not null):

| Decision | Rows |
| --- | ---: |
| `keeplines` (partial removal) | 26 |
| `keepall` (whole result kept) | 18 |
| `forgetall` (whole result dropped) | 2 |
| no decision (fail-open, or the engine's at-rest receipt) | 14 |

Row order is `seq` order. The row set is eligibility-only: no `used`, no `rf`, no
`censoredClass` appears in any row — stage 2 is the only writer of those, and a file stage 2
writes is never read back here.

## The two rows that do not reproduce, named

The reproduction check re-renders every shaped body from the transcript and compares byte for
byte. The mint's last run was **28 matched / 2 censored by name / 0 silent**. The two are the
engine's own at-rest proof receipts, not decisions:

| seq | step | file | bytes dropped |
| ---: | ---: | --- | ---: |
| 107 | 6 | `AGENTS.md` | 8 320 |
| 195 | 12 | `PRD.md` | 44 768 |

Their `decisions` is null by construction. They are counted in the 60 rows and excluded from
every percentage.

## How to regenerate it

Read-only inputs, hashes as read on 2026-10-28:

| Input | sha256 |
| --- | --- |
| run B transcript, `session.v4.jsonl` | `f535d91dab74918ed992ed669ff63e8087297ae5d5d73ccd639d93896e68a2e1` |
| run B ledger copy, `ledger.sqlite` | `832a60f2aa136b09f556fe57ba40db6297dc954dd6b2299c48b23123b40dc6c6` |
| converter census over run B (`live-census.json`) | `6e8211e0314216945771968489f833b447817fb0cd84aa67c2afd16779a93549` |
| converter units over run B (`live-units.jsonl`) | `4460c7bea5e881ddf9316600399ef18ac7f219bfeac613401bac1e90417369ad` |

On this device the sources sit under
`scratchpad/launch/2026-10-26-phase-r-v2/run-b/` and `scratchpad/diag-runb2-convert/`. Second
device (`C:\Users\TZ\…`): the same paths with `C:\Users\TZhen\` replaced by `C:\Users\TZ\`.```
node dev/bench/multiturn/live-convert.mjs --manifest <one-arm manifest> --floor 1280 \
  --ledger <run-b ledger copy> --out <census dir>

node dev/sim/mint-stage1.mjs --units <census dir> --transcript <run B session.v4.jsonl> \
  --out <mint dir> --floor 1280 --arm racoons --run run-b --ledger <run-b ledger copy>
```

Both steps were re-run on 2026-10-28 from the inputs above. The converter wrote the census and
units whose hashes are in the table; the mint wrote a `minted-set.jsonl` whose sha256 was
`9344942888c10e50f3db16c569bc49c8b0bcae9a045af1e208e8622f3629e81b`. This directory's copy is
that set after the redaction described above; its sha256 is
`e01ccddc6ae2f3ada309ca16e1960d521c510fabbac7f275d91bebcffeec5f03`. The mint's own gate printed
`GREEN — 60 row(s), n 28 of |J| 60, 30 shaped body(ies) byte for byte`.

## Who reads it

- **Stage 2 scoring** (`dev/sim/sim-score.mjs` and its callers) reads this file as the frozen
  moment list; it never re-derives the moments from the transcript.
- **ISSUE-061**'s A/B runs over the same set, so both sides are scored on identical moments.

Stage-2 results are recorded separately, in their own dated `docs/research/` note; nothing about
a score belongs in this directory.
