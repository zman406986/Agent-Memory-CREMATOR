# Bench brief — extended-32 follow-up: the remaining nineteen records

This file holds the **exact task text** for the resumed second half of the
extended-32 run. The launcher reads it with `--brief <this file>` and extracts
the first fenced block under *Task text*; nothing else in this file reaches the
agent. `taskSha256` is taken over that block, so any edit here is a new task and
a new freeze.

It is a new file, not an edit of `dev/bench/bench-brief-extended-32.md`. The
resumed session already wrote the first thirteen records (`00-` through `12-`)
under `docs/plans/2026-10-27-extended-audit/`; this text covers records `13-`
through `31-` and does not restate the thirteen. The rules, the four-column set
table, the verdict vocabulary and the finish line are unchanged. Do not tune
the task per arm.

## What the agent can see

- The arm directory is its working directory: a still image of the game project
  at `C:\Users\TZhen\Desktop\racoons-bench\2026-10-23-aetherium\racoons-arm`
  (other device:
  `C:\Users\TZ\Desktop\racoons-bench\2026-10-23-aetherium\racoons-arm`). The
  image has no `.git`.
- No subagent tools; the deny is structural (`dev/bench/subagent-deny.md`, a
  launcher-side file).
- Nothing else: the task names no external path, gives no expected findings and
  no token budget, turn cap or time hint. One wall-clock kill box exists and is
  not disclosed.

## The bound

The nineteen sets are the bottom nineteen rows of the bound table in
`dev/bench/bench-brief-extended-32.md`, re-derived from the same frozen image.
Reads count file-reads, not distinct files: T13, T14 and T15 re-read files T2
already reads; T16 and T17 re-read T8 and T9 exactly. The full task is 1,272
reads over 14,376 KiB; the thirteen finished records account for 462 of those
reads and 6,980 KiB, leaving the 810 reads and 7,396 KiB below.

| Set | Deliverable | Reads | KiB |
| --- | --- | --- | --- |
| T13 ADR ledger — `docs/adr/` | 13 | 7 | 41 |
| T14 law-guide ledger — `docs/guides/law-*.md` | 14 | 7 | 43 |
| T15 reference-guide ledger — `docs/guides/ref-*.md` + `docs/guides/index.md` | 15 | 13 | 97 |
| T16 resolved ledger — `issue-tracker/resolved/` | 16 | 53 | 799 |
| T17 open acceptance — `issue-tracker/open/` | 17 | 27 | 333 |
| T18 archive early — eleven named files under `archive/` | 18 | 11 | 233 |
| T19 archive late — thirteen named files under `archive/` | 19 | 13 | 165 |
| T20 art/audio archive — `archive/2026-09-28-art-audio-pipeline/` | 20 | 6 | 75 |
| T21 paint archive — `archive/ms-paint-experiment-archive/` | 21 | 3 | 190 |
| T22 dev probes — `dev/fengari-check/` + `dev/beyond-simulator/` | 22 | 7 | 48 |
| T23 tool ledger — `tools/payload_bundle/` + `tools/sprite_encode/` | 23 | 18 | 231 |
| T24 pipeline reviews — `pipeline/output/architecture/` + `pipeline/output/reviews/` | 24 | 13 | 151 |
| T25 building protocol matrix — `docs/project/building/` | 25 | 35 | 290 |
| T26 miliastra design — nineteen files at the root of `miliastra design plan/` | 26 | 19 | 968 |
| T27 miliastra audit one — `miliastra design plan/audit No.1/` | 27 | 19 | 169 |
| T28 miliastra audit two — `miliastra design plan/audit No.2/` | 28 | 21 | 358 |
| T29 previous attempt — `previous attempt/` | 29 | 179 | 1468 |
| T30 enigmata decompiled — `.as` and `.csv` under `…/decompiled-flash-source/` | 30 | 339 | 1326 |
| T31 other games — `.md` and `.lua` under `other games reference material/` | 31 | 20 | 411 |
| **total** | | **810** | **7396** |

T30's 339 reads are the `.as` files plus the one `.csv`; the 44 media files
under that tree are recorded by path and byte size in a separate table, never
opened. T31 reads no `.gil`: those archives are binary and are audited only
through the index that names them.

## Task text

```text
You are resuming one bounded audit: thirty-one numbered passes over this
repository, a game project written mostly in Markdown and Lua, with one
TypeScript prototype. Each pass reads a named set of files and writes one named
record.

An earlier session completed passes 1 through 12 and wrote records 00-index.md
through 12-corpus-zh.md under docs/plans/2026-10-27-extended-audit/; do not
rewrite, extend, or reopen those thirteen. Your job is the remaining nineteen
passes, 13 through 31, under the same rules and the same set table.

Terms you need:
- Record: a Markdown file you write under docs/plans/2026-10-27-extended-audit/.
- Set table: the first table of every record you write. It has exactly four
  columns — Path, Lines, Verdict, Finding — one row per file read, sorted by
  path. Lines is the file's line count (0 for an empty file). Finding is at most
  25 words of your own prose; a quoted heading and an issue's exact title are
  not counted. Verdict is one of:
  clean (every repo path the file names exists and no claim in it is
  contradicted by another file in the same set);
  stale (a claim in it is contradicted by another file in the same set);
  absent (it names at least one repo path that does not exist);
  not-text (a placeholder or a binary file you record without reading).
  When more than one applies, use the first in this order: not-text, absent,
  stale, clean.
- Repo path: a path inside this checkout, written in backticks, that begins
  with a top-level name: AGENTS.md, CONTEXT.md, PRD.md, API_MIGRATION.md,
  PROTOTYPE1_SUMMARY.md, pipeline.md, reminder.md, tracker.md, docs/, dev/,
  issue-tracker/, pipeline/, platform-free-core/, client-scripts/, tools/,
  locale/, archive/, prototype test/, other games reference material/,
  miliastra design plan/, or previous attempt/. A path beginning ../ or a URL
  is outside this checkout: give it one line marked outside and do not resolve
  it.
- A-row: one of the nine still-unanswered platform questions, numbered A1 to
  A9 (PRD.md section 5.2, and the folder
  docs/project/building/phase0-protocols/). A file's header names the A-row it
  is waiting on.
- Index file: a Markdown file named index.md that lists the files beside it.

Rules that still bind:
- Write every record under docs/plans/2026-10-27-extended-audit/ and write
  nothing outside that folder. Do not delete a file, do not edit any existing
  file, and do not add a README.md anywhere. The seven index files named in
  pass 2 were handled in the earlier session: leave them alone.
- Read every file in the named set yourself, in this one session, and read
  nothing else. Read only files inside this checkout. Do not reopen the
  thirteen finished records; this task names everything that remains.
- Every record opens with its set table. A pass may add tables after it; the
  set table keeps its four columns.
- If a path you expect is missing, put absent in that row and continue. Do not
  look for it outside the named set.

Your reads, and nothing else:
- docs/adr/ — every file, pass 13.
- docs/guides/law-*.md — pass 14.
- docs/guides/ref-*.md plus docs/guides/index.md — pass 15.
- issue-tracker/resolved/ — every file, pass 16.
- issue-tracker/open/ — every file, pass 17.
- archive/ — exactly the eleven files pass 18 names and exactly the thirteen
  files pass 19 names.
- archive/2026-09-28-art-audio-pipeline/ — every file, pass 20.
- archive/ms-paint-experiment-archive/ — every file, pass 21.
- dev/fengari-check/ and dev/beyond-simulator/ — every file, pass 22.
- tools/payload_bundle/ and tools/sprite_encode/, including
  tools/sprite_encode/tests/ — every file, pass 23.
- pipeline/output/architecture/ and pipeline/output/reviews/ — every file,
  pass 24.
- docs/project/building/ — every file, including both index.md, pass 25.
- miliastra design plan/ — the nineteen files directly under it, pass 26; do
  not enter either audit folder.
- miliastra design plan/audit No.1/ — every file, pass 27.
- miliastra design plan/audit No.2/ — every file, pass 28.
- previous attempt/ — every .md file, pass 29.
- other games reference material/enigmata-stellar-war/decompiled-flash-source/
  — every .as file and the one .csv, pass 30.
- other games reference material/ — every .md and .lua file outside
  decompiled-flash-source/, pass 31.

The 44 media files under the enigmata tree are not read; pass 30 records them
by path and byte size. No .gil file is read.

13. T13 — ADR ledger.
    Read every file under docs/adr/. Write 13-adr-ledger.md: the set table.
    Then one row per ADR (not index.md) giving its number, its title, its
    Status: line verbatim with wrapped lines joined, and every issue number its
    body names with whether a file in issue-tracker/resolved/ or
    issue-tracker/open/ matches that number. Then list every ADR whose Status:
    or Law: line names another ADR number, and every ADR naming an issue number
    with no file. Then check docs/adr/index.md: every ADR file has a row, every
    row's Law cell starts with the text after that ADR's own Law: label, and
    every row names a file that exists. Do not edit index.md; list each
    mismatch in your record instead.

14. T14 — law guides.
    Read every docs/guides/law-*.md. Write 14-law-guide-ledger.md: the set
    table. Then one row per level-2 heading that states a rule, giving the
    guide, the heading text, the first clause of the rule (at most 12 words),
    and the command, tool, or path the guide says enforces it, or none. Then
    list every rule with no enforcement point and every enforcement path that
    does not exist.

15. T15 — reference guides.
    Read every docs/guides/ref-*.md plus docs/guides/index.md. Write
    15-reference-guide-ledger.md: the set table. Then one row per file giving
    up to five integer counts it states, each with the noun counted, or none.
    Then one row per quantity that two files in the set state with different
    values, naming both files and both values; if there is none, one row
    saying none. Then list every row in docs/guides/index.md whose target path
    does not exist.

16. T16 — resolved ledger.
    Read every file under issue-tracker/resolved/, including the .gitkeep
    (give it a not-text row). Write 16-resolved-ledger.md: the set table. Then
    one row per issue giving its number, its exact title, every repo path its
    body names, and whether each exists. Then list issues naming at least one
    absent path, and issues whose body names a resolved issue with a higher
    number than their own.

17. T17 — open acceptance.
    Read every file under issue-tracker/open/, including the .gitkeep (give it
    a not-text row). Write 17-open-acceptance-ledger.md: the set table. Then
    one row per issue giving its number, its Type, its Triage, the number of
    acceptance items it states (a checked or unchecked box, or a numbered DoD
    item), and every A-row number it names, or none. Then list issues with zero
    acceptance items and issues naming a repo path that is absent.

18. T18 — archive early.
    Read these eleven files and no others:
    archive/00-template-reference-index.md,
    archive/2026-09-23-genshin-ts-vendored-clone.md,
    archive/2026-09-23-ugc-evidence-a1-a9.md,
    archive/2026-09-25-community-prior-art-research.md,
    archive/2026-09-25-local-prior-art-gil-and-scripts.md,
    archive/2026-09-25-paint-experiment-lessons.md,
    archive/2026-09-26-example-deepdive-badapple.md,
    archive/2026-09-26-example-deepdive-lua2048.md,
    archive/2026-09-26-example-deepdive-pure2d-template.md,
    archive/2026-09-26-example-deepdive-tank-battle.md,
    archive/2026-09-26-example-scripts-deep-dive-input-and-canvas.md.
    Write 18-archive-early-ledger.md: the set table. Then one row per file
    giving the provenance it states (a date, a source project, an experiment
    id, or none) and whether archive/00-template-reference-index.md has a row
    naming it. Then list files the index does not name other than itself, and
    every path the index names that resolves inside archive/ and does not
    exist.

19. T19 — archive late.
    Read these thirteen files and no others:
    archive/.gitkeep,
    archive/2026-09-27-previous-attempt-salvage-record.md,
    archive/2026-09-28-doc-debloat-extract.md,
    archive/2026-09-28-footprint-and-effect-provenance.md,
    archive/2026-09-28-gia-pixel-pack-measurement.md,
    archive/2026-09-28-save-key-census.md,
    archive/2026-09-30-client-runtime-verdicts-and-lessons.md,
    archive/PRD-SKELETON.md, archive/TEMPLATE-GUIDE.md,
    archive/domain-docs.md, archive/platform-facts-register.md,
    archive/process-pitfalls.md, archive/read-before-agent-ops.md.
    Write 19-archive-late-ledger.md: the set table. Then one row per file
    giving the durable claim it makes (a measured number, a rule, or a named
    pitfall) and the file under docs/project/ or docs/guides/ that now holds
    it, or none. Then list files whose claim has no durable home.

20. T20 — art/audio archive.
    Read every file under archive/2026-09-28-art-audio-pipeline/. Write
    20-archive-art-audio-ledger.md: the set table. Then one row per file giving
    up to five measured numbers it states (value, unit, and what is counted),
    or none. Then one row per quantity that two files in the set state with
    different values, naming both files and both values; if there is none, one
    row saying none. Then list every repo path the six files name that does not
    exist.

21. T21 — paint archive.
    Read every file under archive/ms-paint-experiment-archive/. Write
    21-archive-paint-ledger.md: the set table. Then one row per level-2
    heading, giving the heading text, the editor operation or measurement it
    reports, and whether the file states a pass or fail outcome. Then list
    headings with no stated outcome and every repo path the three files name
    that does not exist.

22. T22 — dev probes.
    Read every file under dev/fengari-check/ and dev/beyond-simulator/. Write
    22-dev-probe-ledger.md: the set table. Then one row per runnable command a
    README in those directories prints, giving its exact command line, the
    success line or JSON key it produces, and whether that README documents the
    output. Then list outputs no README documents and every repo path a README
    names that does not exist.

23. T23 — tool ledger.
    Read every file under tools/payload_bundle/ and tools/sprite_encode/,
    including tools/sprite_encode/tests/. Write 23-tool-ledger.md: the set
    table. Then one row per tool (payload_bundle, sprite_encode) giving its
    input, its output, the command its README gives, and whether every repo
    path the README names exists. Then list every source file no README names
    and every test file no test runner or README names.

24. T24 — pipeline reviews.
    Read every file under pipeline/output/architecture/ and
    pipeline/output/reviews/. Write 24-pipeline-review-ledger.md: the set
    table. Then one row per review giving the architecture or plan file its
    first heading names, whether that target exists, and its Verdict: line
    verbatim or none. Then list reviews whose target is absent and reviews with
    no Verdict line.

25. T25 — building protocol matrix.
    Read every file under docs/project/building/, including both index.md
    files. Write 25-building-protocol-matrix.md: the set table. Then one row
    per A-row A1 to A9 giving the protocol file, the fixture file, the
    decisions file or none, and the open issue that names it or none. Then list
    every A-row missing one of the four, and every repo path the two index.md
    files name that does not exist.

26. T26 — miliastra design.
    Read the nineteen files directly under miliastra design plan/; do not enter
    either audit folder. Write 26-miliastra-design-ledger.md: the set table.
    Then one row per DESIGN_UGC_nn or IMPL_nn file giving its subject system
    and whether its counterpart with the same number exists (DESIGN_UGC_01
    pairs IMPL_01, the two MASTER files pair, and GLOSSARY_REPLACEMENTS.md and
    REVISION_WHITEBOARD.md have no counterpart). Then list every pair that
    states a different value for the same named constant or limit, with both
    values.

27. T27 — miliastra audit one.
    Read every file under miliastra design plan/audit No.1/. Write
    27-miliastra-audit-one-ledger.md: the set table. Then one row per
    *-audit.md file giving its target file in the parent directory, whether
    that target exists, and its stated score or verdict, or none. Then list
    audits whose target is absent and audits with no score or verdict. Then
    list every repo path the audits name that does not exist.

28. T28 — miliastra audit two.
    Read every file under miliastra design plan/audit No.2/. Write
    28-miliastra-audit-two-ledger.md: the set table. Then one row per
    *-audit.md file giving its target file in the parent directory, whether
    that target exists, its stated score, and whether audit No.1 holds a file
    with the same basename. Then list No.2 audits with no No.1 counterpart,
    every pair whose score differs, and every target that is absent. Then one
    row for each of KB_ROUTING_INDEX.md, SUMMARY_REPORT.md and WHITEBOARD.md
    giving what it claims.

29. T29 — previous attempt.
    Read every .md file under previous attempt/. Write
    29-previous-attempt-ledger.md: the set table. Then one row per pass file
    under previous attempt/archive/audit-v2/passes/ giving its output folder
    and how many files under previous attempt/archive/audit-v2/output/ it
    names. Then list output files no pass names and pass files that name no
    output. Then list every pair where a file's path under
    previous attempt/archive/ matches a path under pipeline/ and the two byte
    sizes differ.

30. T30 — enigmata decompiled.
    Read every .as file and the one .csv file under
    other games reference material/enigmata-stellar-war/decompiled-flash-source/.
    Do not open the .mp3, .png or .jpg files; record each in the media table
    described below. Write 30-enigmata-decompiled-ledger.md: the set table for
    the .as and .csv files. Then one row per .as file giving its declared class
    or interface name or none, its superclass or implements list or none, and
    whether that name equals the filename stem (say no when the name is none).
    Then list files with no package declaration, class names its body references
    that no file declares, and every .as file larger than 100,000 bytes. End
    with one table of the media files, one row per file, columns Path, Bytes,
    Verdict (always not-text).

31. T31 — other games.
    Read every .md and .lua file under other games reference material/ except
    under decompiled-flash-source/. Write 31-other-games-ledger.md: the set
    table. Then one row per folder (the root, enigmata-stellar-war,
    Beyond_Local_Save_Level, each numbered save directory, example gil,
    upstream caches) giving the number of files its index or README says it
    holds and the number present. Then list every count that disagrees, every
    file an index names that is absent, and every present file no index names.

The nineteen records are, by exact filename:
13-adr-ledger.md
14-law-guide-ledger.md
15-reference-guide-ledger.md
16-resolved-ledger.md
17-open-acceptance-ledger.md
18-archive-early-ledger.md
19-archive-late-ledger.md
20-archive-art-audio-ledger.md
21-archive-paint-ledger.md
22-dev-probe-ledger.md
23-tool-ledger.md
24-pipeline-review-ledger.md
25-building-protocol-matrix.md
26-miliastra-design-ledger.md
27-miliastra-audit-one-ledger.md
28-miliastra-audit-two-ledger.md
29-previous-attempt-ledger.md
30-enigmata-decompiled-ledger.md
31-other-games-ledger.md

Write no other file. When those nineteen files exist under
docs/plans/2026-10-27-extended-audit/, print exactly one line:

BENCH-DONE

as the last line of an assistant message that also states, in at most three
sentences, what you produced. After that line, stop: no further message, no
further edit, no further read.
```

## Done criteria (what the reviewer checks)

1. The nineteen files above exist under `docs/plans/2026-10-27-extended-audit/`
   with those exact names.
2. Each record's first table is the four-column set table, one row per file
   read, sorted by path, at most 25 words of the record's own prose per row.
   T29's set table has 179 rows; T30's has 339 set rows plus 44 media rows;
   T31's has 20 rows.
3. The thirteen earlier records are byte-identical to what the earlier session
   wrote, and no file outside the audit folder was edited, added or deleted.
4. `BENCH-DONE` appears exactly once, as the last line of the last message; any
   edit after it is late-after-done, counted once per file.
