# Bench brief — extended-32: the thirty-two-record audit both arms get

This file holds the **exact task text** handed to both arms of the extended-32
run, word for word. The launcher reads it with `--brief <this file>` and extracts
the first fenced block under *Task text*; nothing else in this file reaches the
agent. `taskSha256` is taken over that block, so any edit here is a new task and
a new freeze.

It is a new file, not an edit of `dev/bench/bench-brief.md`,
`dev/bench/bench-brief-035.md` or `dev/bench/bench-brief-extended.md`. Round 1 of
`dev/bench/bench-brief.md` failed because its task had no terminus; 035 bounded
the work to 74 Markdown files; `bench-brief-extended.md` bounded it to twelve
named sets. This one bounds it to thirty-one named sets across the whole tree
(1,272 file-reads, 14,376 KiB) and ends at the same numbered finish line. It is
long enough that the product arm is forced into its first native compaction.

Do not tune the task per arm. Nothing in the task names an arm, a token grant, a
clock, or a window.

## What the agent can see

- The arm directory is its working directory: a still image of the game project
  at `C:\Users\TZhen\Desktop\racoons-bench\2026-10-23-aetherium\racoons-arm`
  (other device:
  `C:\Users\TZ\Desktop\racoons-bench\2026-10-23-aetherium\racoons-arm`). The
  image has no `.git`.
- No subagent tools; the deny is structural (`dev/bench/subagent-deny.md`, a
  launcher-side file).
- Nothing else. The task names no external path and never mentions the template
  checkout or the racoons repo. The launcher may still allow-read it; the brief
  does not.

## The bound

The thirty-one sets and their sizes come from a read-only walk of the frozen
image: every file under each named path, counted, and its byte size summed.
Anyone can re-derive the table with any directory walk; the reviewer does. The
two device paths that hold the image are listed above.

| Set | Deliverable | Files | KiB |
| --- | --- | --- | --- |
| T1 orientation — six entry documents | 1 | 6 | 64 |
| T2 entry currency — `docs/project/`, `docs/guides/`, `docs/adr/` | 2 | 71 | 499 |
| T3 core charter — `platform-free-core/*.lua` + README + gate doc | 3 | 24 | 828 |
| T4 core tests — `platform-free-core/dev/` | 4 | 23 | 561 |
| T5 shell quarantine — `client-scripts/` + gate doc | 5 | 17 | 411 |
| T6 gate coverage — `dev/lua-gate/` + gate doc | 6 | 26 | 87 |
| T7 plan traceability — `pipeline/output/module_plans/` + prototype TypeScript tree | 7 | 49 | 370 |
| T8 distillation audit — `issue-tracker/resolved/` | 8 | 53 | 799 |
| T9 open triage — `issue-tracker/open/` | 9 | 27 | 333 |
| T10 plans disposition — `docs/plans/` | 10 | 82 | 1797 |
| T11 corpus EN — `docs/official-docs-mirror-en-us/knowledge/node-introduction/` | 11 | 42 | 681 |
| T12 corpus ZH — `docs/official-docs-mirror-zh-cn/knowledge/node-introduction/` | 12 | 42 | 550 |
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
| **total** | | **1272** | **14376** |

Every count above counts file-reads, not distinct files: the overlaps are
`docs/project/building/ref-lua-subset-gate.md` (T2, T3, T5, T6, T25) and the
three index files T1 shares with T2. T13, T14, T15 and T25 re-read files T2
already reads; T16 and T17 re-read T8 and T9 exactly. 1272 reads over 1124
distinct files. T10's "except `2026-10-27-extended-audit/`" costs nothing beyond
the empty folder: it is excluded so the agent does not read its own output back
into T10. T30 does not read the 44 media files under that tree; it records them
by path and byte size in a separate table. T31 reads no `.gil`: those archives
are binary and are audited only through the index that names them.

## What the agent is NOT given

- No list of defects, no expected findings, no per-set answer key.
- No token budget, turn cap, or time hint. One wall-clock kill box exists and
  is not disclosed.
- No instruction that the records will be compared against a reference pass.

## Task text

Everything inside the fence below is the task, verbatim. A long brief would
drift; this one is bounded instead, and every deliverable says what file it
writes.

```text
This repository is a game project written mostly in Markdown and Lua, with one
TypeScript prototype. Your job is a bounded audit: thirty-one numbered passes,
each reading a named set of files and writing one named record of what it found.

Terms, each defined once:
- Record: a Markdown file you write under docs/plans/2026-10-27-extended-audit/.
- Entry documents: AGENTS.md, CONTEXT.md, PRD.md, docs/project/index.md,
  docs/guides/index.md, docs/adr/index.md.
- Index file: a Markdown file named index.md that lists the files beside it.
- Core: the directory platform-free-core/, pure-Lua rules modules.
- Gate: the checker in dev/lua-gate/ that reads Lua source text and prints one
  line per violation. A fixture is a small Lua file the gate must accept or
  reject.
- Plan: a Markdown file under pipeline/output/module_plans/ that describes one
  TypeScript file under "prototype test/Prototype1/src/". That directory name
  contains a space.
- Corpus: a copied third-party document set under
  docs/official-docs-mirror-en-us/ or docs/official-docs-mirror-zh-cn/. Its
  front matter is the key: value block between the first two --- lines.
  path_id is this project's stable name for one copied article; real_id is the
  name the source site uses for it; parent_path_id names the article one level
  up in the same tree.
- A-row: one of the nine still-unanswered platform questions, numbered A1 to
  A9 (PRD.md section 5.2, and the folder docs/project/building/phase0-protocols/).
  A file's header names the A-row it is waiting on.
- Distilled finding: a measured fact, a repeatable procedure, or a named
  pitfall. A narrative, a chronology, and a status line are none of these.
- ADR: a file docs/adr/ADR-NNNN-*.md. Its Status: line states whether it is
  accepted, and its Law: line states the decision in force.
- Law guide: a file docs/guides/law-*.md, stating a rule for a kind of work.
- Reference guide: a file docs/guides/ref-*.md, holding measured facts about
  the corpus, the platform, or a tool.
- Archive record: a file under archive/, a verbatim witness or a dated lesson.
  It is evidence, never a ruling.
- Set table: the first table of every record from pass 13 on. It has exactly
  four columns — Path, Lines, Verdict, Finding — one row per file read, sorted
  by path. Lines is the file's line count (0 for an empty file). Finding is at
  most 25 words of your own prose. Verdict is one of:
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
  is outside this checkout: list it once, marked outside, and do not resolve it.

Rules that hold for all thirty-one passes:
- Read every file in the named set yourself, in this one session. All
  thirty-one passes are yours to do; there is no shortcut around reading the
  files.
- Each numbered record opens with the table its pass names; where the pass says
  one row per file, the table has one row per file read, sorted by path, with at
  most 25 words of your own prose per row (quoted headings and an issue's exact
  title are not counted). From pass 13 on, that first table is the set table,
  with the four columns and the Verdict vocabulary defined above.
- Write nothing outside docs/plans/2026-10-27-extended-audit/ except the seven
  index files named in pass 2. Do not delete a file. Do not edit any other
  existing file. Do not add a README.md anywhere.
- If a path you expect is missing, put "absent" in that row and continue. Do
  not look for it outside the named set.
- A repo path that begins ../ or a URL is outside this checkout: give it one
  line marked outside in the relevant list and do not resolve it.

1. T1 — orientation.
   Read the six entry documents. Write 00-index.md: three sentences on what
   this job is; a table of the thirty-two records by path with one line each; and
   a list of the files this job may write. Write 01-orientation.md: one row per
   entry document, giving its level-2 headings in order, separated by
   semicolons.

2. T2 — entry currency.
   Read every file under docs/project/, docs/guides/ and docs/adr/, including
   every subdirectory. Write 02-entry-currency.md: the per-file table, then a
   second table of every repo-relative path cited in those files that does not
   exist on disk, with the citing file and line. Paths beginning `../` are
   outside this checkout: list them once, marked outside, and do not resolve
   them. Then check each of these seven
   index files against the directory that holds it: docs/project/index.md,
   docs/project/building/index.md,
   docs/project/building/phase0-protocols/index.md,
   docs/project/platform/index.md, docs/project/sessions/index.md,
   docs/guides/index.md, docs/adr/index.md. An index is correct when every .md
   file beside it (other than itself) has a row, every subdirectory's index.md
   has a row, and every row names a file or folder that exists. Fix only what
   is missing or stale; leave correct rows byte-for-byte alone. Record one line
   per index saying "complete" or listing what you changed. Exception: repo law
   governs docs/adr/index.md, so leave it byte-for-byte untouched and produce
   your own table of the ADRs you read in your record instead. Do not edit any
   file outside these seven and your own record.

3. T3 — core charter.
   Read every .lua file directly under platform-free-core/, plus
   platform-free-core/README.md and
   docs/project/building/ref-lua-subset-gate.md. Write 03-core-charter.md: one
   row per file saying what it computes in one sentence. Then list every file
   in that set that names a host global (game, script, Enum, Color, typeof), a
   control-painting member, a coordinate read or write, or a clock/tick call,
   with the line number.

4. T4 — core tests.
   Read every file under platform-free-core/dev/: the runner run_tests.lua, the
   registration list suite.lua, and every test_*.lua. Write 04-core-tests.md:
   the per-file table, each row naming the core module that file covers or
   "runner", "list", or "none". Then two lists: rows in suite.lua whose file is
   absent from the directory, and test_*.lua files that no row in suite.lua
   names.

5. T5 — shell quarantine.
   Read every file under client-scripts/ and
   docs/project/building/ref-lua-subset-gate.md. Write 05-shell-quarantine.md:
   the per-file table, with the A-row number or named constant in each file's
   header where one is stated. Then, for each of the four searches in
   client-scripts/README.md under "How an integrator proves the quarantine (four
   bounded searches)", record the pattern searched, the path searched, the
   number of lines that matched, and a verdict (clean, or how many matched
   lines need review). Run them by whatever means your tools give you. Where
   the README prints a shell pipeline, reproduce the same filter by reading and
   counting instead, and say so in the row.

6. T6 — gate coverage.
   Read every file under dev/lua-gate/ (gate.lua, manifest.lua, run.ps1,
   test_gate.lua, and every file under fixtures/) and
   docs/project/building/ref-lua-subset-gate.md. Write 06-gate-coverage.md: one
   row per entry of the gate.codes table in gate.lua, giving the code name, the
   fixture under dev/lua-gate/fixtures/ that exercises it or "no fixture", and
   whether ref-lua-subset-gate.md names that code. Then list every fixture that
   no gate code claims.

7. T7 — plan traceability.
   Read every file under pipeline/output/module_plans/ and every file under
   "prototype test/Prototype1/src/". Write 07-plan-traceability.md: one row per
   TypeScript file naming the plan whose File: line names it, or "no plan".
   Then one row per plan giving its File: line target and whether that target
   exists. Then list every pair where the plan exists and the target does not.

8. T8 — distillation audit.
   Read every file under issue-tracker/resolved/, including the .gitkeep (give
   it a row that says "not an issue"). Write 08-distillation-audit.md: one row
   per issue giving its number, its title, and the file under docs/project/ or
   docs/guides/ that now holds its distilled finding, or "none". When more than
   one issue could hold a finding's distilled record, pick the earliest-numbered
   such issue and say `ambiguous: <ids>` in the row. Then list,
   grouped by topic, every issue whose finding has no durable home, with one
   sentence on where it belongs.

9. T9 — open triage.
   Read every file under issue-tracker/open/, including the .gitkeep (give it a
   row that says "not an issue"). Write 09-open-triage.md: one row per issue
   giving its number, title, Type, Triage, Status, and whether Status matches
   the folder it sits in. Then two lists: files whose Triage value is not one of
   needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix; and
   files whose filename state segment disagrees with the folder.

10. T10 — plans disposition.
    Read every file under docs/plans/ except the folder
    2026-10-27-extended-audit/. Write 10-plans-disposition.md: one row per
    subdirectory giving its file count, its entry document (a README.md or a
    00-*.md, or "none") and whether it is still in flight; then one row for
    docs/plans/human-decisions-index.md, which is the only file sitting loose at
    that root. Then a list of folders that look finished and could move to
    archive/, each with one reason.

11. T11 — corpus EN.
    Read every .md file under
    docs/official-docs-mirror-en-us/knowledge/node-introduction/. Write
    11-corpus-en.md: one row per file giving its path_id, its tier, its title,
    and its parent_path_id with whether that id appears as a path_id anywhere
    in the same tree. Then list every file with no parent_path_id.

12. T12 — corpus ZH.
    Read every .md file under
    docs/official-docs-mirror-zh-cn/knowledge/node-introduction/. Write
    12-corpus-zh.md: one row per file giving its path_id, whether path_id
    equals real_id, and whether a file with the same relative path exists under
    docs/official-docs-mirror-en-us/. Then list every file whose path_id does
    not equal its real_id.

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
    every path the index names that resolves inside archive/ and does not exist.

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
    row saying none. Then list every repo path the six files name that does
    not exist.

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

The thirty-two records are, by exact filename:
00-index.md
01-orientation.md
02-entry-currency.md
03-core-charter.md
04-core-tests.md
05-shell-quarantine.md
06-gate-coverage.md
07-plan-traceability.md
08-distillation-audit.md
09-open-triage.md
10-plans-disposition.md
11-corpus-en.md
12-corpus-zh.md
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

When all thirty-two files under docs/plans/2026-10-27-extended-audit/ exist and
the seven index files have each been checked against their directory and fixed
where they were wrong, print exactly one line:

BENCH-DONE

as the last line of an assistant message that also states, in at most three
sentences, what you produced. After that line, stop: no further message, no
further edit, no further read.
```

## Done criteria (what the reviewer checks)

1. Thirty-two files exist under `docs/plans/2026-10-27-extended-audit/`, with
   the exact names listed at the end of the task text: `00-index.md`,
   `01-` through `31-`.
2. Each numbered record's first table follows the rule in the task: where the
   pass says one row per file, one row per file read, sorted by path, at most 25
   words of the record's own prose per row (quoted headings and an issue's exact
   title are not counted). From pass 13 on, the first table has exactly the four
   columns `Path | Lines | Verdict | Finding`, and Verdict is one of `clean`,
   `stale`, `absent`, `not-text`. Where a pass names another shape, its shape
   wins: T7's first table is one row per TypeScript file (28), followed by one
   row per plan (21); T10's first table is one row per subdirectory (9) plus one
   row for `docs/plans/human-decisions-index.md`, 10 rows over 82 files read.
   T29's set table has 179 rows; T30's has 339 set rows plus 44 media rows;
   T31's has 20 rows. Reads follow the table above, which counts reads, not
   distinct files.
3. The seven index files match their directories after pass 2, except
   `docs/adr/index.md`: repo law governs it, so leave it byte-for-byte untouched
   and produce your own table of the ADRs you read in your record instead. T13
   checks it read-only and edits nothing.
4. No file outside the audit folder and those seven indexes was edited, added
   or deleted.
5. `BENCH-DONE` appears exactly once, as the last line of the last message; any
   edit after it is late-after-done, counted once per file.

## Path check

Every path the task names was confirmed in
`C:\Users\TZhen\Desktop\racoons-bench\2026-10-23-aetherium\racoons-arm` (other
device:
`C:\Users\TZ\Desktop\racoons-bench\2026-10-23-aetherium\racoons-arm`) on
2026-11-09. The frozen image has no `.git`, so the counts in the bound table were
taken from that image directly. The only paths the task tells the agent to
create are under `docs/plans/2026-10-27-extended-audit/`, which exists empty in
the image. No bench-doc tree exists in this image: the "bench docs" set named in
the authoring instruction was absent, so it was replaced by T29 (`previous
attempt/`), T30 (the enigmata decompiled text) and T31 (the other-games
reference set), all of which exist in quantity. Every file in every named set in
the bound table was confirmed present; no file inside a named set was swapped.

## Required file names (harness gate)

The harness gates on these thirty-two exact names under
`docs/plans/2026-10-27-extended-audit/`. This list repeats the one at the end of
the task text; the two must stay identical.

- 00-index.md
- 01-orientation.md
- 02-entry-currency.md
- 03-core-charter.md
- 04-core-tests.md
- 05-shell-quarantine.md
- 06-gate-coverage.md
- 07-plan-traceability.md
- 08-distillation-audit.md
- 09-open-triage.md
- 10-plans-disposition.md
- 11-corpus-en.md
- 12-corpus-zh.md
- 13-adr-ledger.md
- 14-law-guide-ledger.md
- 15-reference-guide-ledger.md
- 16-resolved-ledger.md
- 17-open-acceptance-ledger.md
- 18-archive-early-ledger.md
- 19-archive-late-ledger.md
- 20-archive-art-audio-ledger.md
- 21-archive-paint-ledger.md
- 22-dev-probe-ledger.md
- 23-tool-ledger.md
- 24-pipeline-review-ledger.md
- 25-building-protocol-matrix.md
- 26-miliastra-design-ledger.md
- 27-miliastra-audit-one-ledger.md
- 28-miliastra-audit-two-ledger.md
- 29-previous-attempt-ledger.md
- 30-enigmata-decompiled-ledger.md
- 31-other-games-ledger.md
