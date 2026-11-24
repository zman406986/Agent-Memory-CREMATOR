# Bench brief — extended: the twelve-set audit both arms get

This file holds the **exact task text** handed to both arms of the extended run,
word for word. The launcher reads it with `--brief <this file>` and extracts the
first fenced block under *Task text*; nothing else in this file reaches the
agent. `taskSha256` is taken over that block, so any edit here is a new task and
a new freeze.

It is a new file, not an edit of `dev/bench/bench-brief.md` or
`dev/bench/bench-brief-035.md` (both launcher-side, never in the arm). Round 1 of
`dev/bench/bench-brief.md` failed because its task had no terminus; 035 bounded
the work to 74 Markdown files. This one bounds it to twelve named sets across the
whole tree (462 file-reads, 6.82 MiB) and ends at a numbered finish line: long
enough that the bulk prune fires at least twice (ISSUE-078, ISSUE-054 c. 2).

Do not tune the task per arm. Nothing in the task names an arm, a token grant, a
clock, or a window.

## What the agent can see

- The arm directory is its working directory: a still image of
  `C:\Users\TZhen\Desktop\Taskworld-Project` (other device:
  `C:\Users\TZ\Desktop\Taskworld-Project`) at `dc2b5bd`.
- No subagent tools; the deny is structural (`dev/bench/subagent-deny.md`, a
  launcher-side file).
- Nothing else. The task names no external path and never mentions the template
  checkout. The launcher may still allow-read it; the brief does not.

## The bound

The twelve sets and their sizes come from a read-only walk of the frozen image:
every file under each named path, counted, and its byte size summed. Anyone can
re-derive the table with any directory walk; the reviewer does.

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
| **total** | | **462** | **6980** |

Every count above counts file-reads, not distinct files: the overlaps are
`docs/project/building/ref-lua-subset-gate.md` (T2, T3, T5, T6) and the three
index files T1 shares with T2. 462 reads over 456 distinct files. T10's "except
`2026-10-27-extended-audit/`" costs nothing — that folder is not in the image, so
82 is all of `docs/plans/`; it is stated so the agent does not read its own
output back into T10.

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
TypeScript prototype. Your job is a bounded audit: twelve numbered passes, each
reading a named set of files and writing one named record of what it found.

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

Rules that hold for all twelve passes:
- Read every file in the named set yourself, in this one session. All twelve
  passes are yours to do; there is no shortcut around reading the files.
- Each numbered record opens with the table its pass names; where the pass says
  one row per file, the table has one row per file read, sorted by path, with at
  most 25 words of your own prose per row (quoted headings and an issue's exact
  title are not counted).
- Write nothing outside docs/plans/2026-10-27-extended-audit/ except the seven
  index files named in pass 2. Do not delete a file. Do not edit any other
  existing file. Do not add a README.md anywhere.
- If a path you expect is missing, put "absent" in that row and continue. Do
  not look for it outside the named set.

1. T1 — orientation.
   Read the six entry documents. Write 00-index.md: three sentences on what
   this job is; a table of the twelve records by path with one line each; and a
   list of the files this job may write. Write 01-orientation.md: one row per
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

When all thirteen files under docs/plans/2026-10-27-extended-audit/ exist and
the seven index files have each been checked against their directory and fixed
where they were wrong, print exactly one line:

BENCH-DONE

as the last line of an assistant message that also states, in at most three
sentences, what you produced. After that line, stop: no further message, no
further edit, no further read.
```

## Done criteria (what the reviewer checks)

1. Thirteen files exist under `docs/plans/2026-10-27-extended-audit/`:
   `00-index.md` and `01-` through `12-`.
2. Each numbered record's first table follows the rule in the task: where the
   pass says one row per file, one row per file read, sorted by path, at most 25
   words of the record's own prose per row (quoted headings and an issue's exact
   title are not counted). Where a pass names another shape, its shape wins: T7's
   first table is one row per TypeScript file (28), followed by one row per plan
   (21); T10's first table is one row per subdirectory (9) plus one row for
   `docs/plans/human-decisions-index.md`, 10 rows over 82 files read. Reads
   follow the table above, which counts reads, not distinct files; T9 may read
   26 or 27, because one open-tracker file exists in tonight's image but is not
   at `dc2b5bd`. The task says "every file", so the tree wins.
3. The seven index files match their directories after pass 2, except
   `docs/adr/index.md`: repo law governs it, so leave it byte-for-byte untouched
   and produce your own table of the ADRs you read in your record instead.
4. No file outside the audit folder and those seven indexes was edited, added
   or deleted.
5. `BENCH-DONE` appears exactly once, as the last line of the last message; any
   edit after it is late-after-done, counted once per file.

## Path check

Every path the task names was confirmed in `C:\Users\TZhen\Desktop\Taskworld-Project`
at `dc2b5bd` (other device: `C:\Users\TZ\Desktop\Taskworld-Project`), which the
frozen image is a still image of. The only paths the task tells the agent to
create are under `docs/plans/2026-10-27-extended-audit/`, which no arm has yet.
