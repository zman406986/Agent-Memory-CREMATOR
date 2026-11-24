# Bench brief 035 — the bounded task both Run B arms get

This file holds the **exact task text** handed to both Run B arms, word for word.
The launcher reads it with `--brief <this file>` and extracts the fenced block
under *Task text*; nothing else in this file reaches the agent.

It is a **new** file, not an edit of `bench-brief.md` (runbook law: a run's task
is never retuned; a different task is a new brief). Round 1 of `bench-brief.md`
failed the box because its task had no terminus: "work through as much of the
repository as you can" over 1787 files, done "when you believe the repository is
current" (`archive/2026-10-24-live-ab-plan.md` §1). This brief bounds the
work to one shelf and states a numbered finish line.

Do not tune the task per arm. If a run needs a different task, that is a new
bench date and a new brief.

The task text is frozen: `taskSha256` is compared across arms and against the
completed vanilla run. So the read boundary is stated here rather than inside
the fence, and it is the same sentence `runbook.md` Step 3 carries — **the arm's
world is its own directory plus the template checkout, read-only; no other path
is in scope, and the launcher fails the run (exit 4) on a `tool/call` naming a
path inside the campaign but outside that world.** A future brief that changes
the task may put the sentence inside the fence; this one may not.

## What the agent can see

- The arm directory is its working directory: a still image of
  `C:\Users\TZhen\Desktop\Taskworld-Project` (other device:
  `C:\Users\TZ\Desktop\Taskworld-Project`) at `dc2b5bd`; the exact source HEAD
  is in each arm's `manifest.json`.
- The template checkout the repo law names as its one allowed sibling path —
  `C:\Users\TZhen\Desktop\miliastra-game-template` (other device:
  `C:\Users\TZ\Desktop\miliastra-game-template`), current HEAD, read-only. The
  agent may read it and must not write it.
- Its own repo's rules: `AGENTS.md`, `CONTEXT.md`, `PRD.md`,
  `docs/project/index.md`, `docs/guides/*.md`.
- No subagent tools. The deny is structural (see `subagent-deny.md`).
- Nothing above its own directory: the launcher runs each arm in its own world
  (`--world`), and a read of any path inside the campaign but outside that world
  fails the run (ISSUE-039). The boundary is stated at the top of this file
  rather than inside the fence, because the task text's bytes are frozen.

## The bound

The task names its own scope. Inside the arm that scope is **74 Markdown files,
0.54 MiB** (the same 74 bytes exist in both arms; digests are equal):

| Set | Files | Why it is the bound |
| --- | --- | --- |
| `AGENTS.md`, `CONTEXT.md`, `PRD.md` | 3 | the entry documents the repo law names |
| `docs/project/**/*.md` | 44 | one shelf; its index is the routing table |
| `docs/guides/**/*.md` | 20 | the procedures the entry documents cite |
| `docs/adr/**/*.md` | 7 | the decisions those documents cite |

Everything else — `docs/plans/`, `docs/official-docs-mirror-*`, `archive/`,
`other games reference material/`, `issue-tracker/`, `dev/`, code — is out of
scope. It may be read only when a file in scope points at it, and is never
edited except where a deliverable says so.

## What the agent is NOT given

- No list of what is stale. Discovering the gap is the measured work.
- No instruction to re-sync `platform-free-core` by pin, and no mention of the
  template's pin gate.
- No token budget, turn cap, or time hint. One wall-clock kill box exists and
  is not disclosed.

## Task text

Everything inside the fence below is the task, verbatim. The brief is
deliberately short: a long brief would drift between arms.

```text
This repository was instantiated from the template checkout at
C:\Users\TZhen\Desktop\miliastra-game-template on 2026-09-27. That template has
since evolved: its documentation conventions, its shelves, and the rules it
ships have changed, and some of this repository's own notes were written
against older versions of both.

Treat the template as read-only reference. Do not edit it, do not copy its
product files in wholesale, and do not run anything inside it.

Your job is bounded. The scope is exactly these 74 Markdown files:
- AGENTS.md, CONTEXT.md, PRD.md
- every .md file under docs/project/
- every .md file under docs/guides/
- every .md file under docs/adr/

Nothing else in this repository is in scope. Read another file only when one of
the 74 points at it, and never edit one outside the scope.

Complete these deliverables, in order. Each is finite; when it is done, move to
the next. Do not expand the scope.

1. For each of the 7 index files in scope (docs/project/index.md,
   docs/project/building/index.md, docs/project/platform/index.md,
   docs/project/sessions/index.md,
   docs/project/building/phase0-protocols/index.md, docs/adr/index.md,
   docs/guides/index.md), make the index match its directory: every file that
   exists there is listed, and no listed file is absent.

2. In the five entry documents (AGENTS.md, CONTEXT.md, PRD.md,
   docs/project/index.md, docs/guides/index.md), make every repo-relative path
   resolve, or say plainly that the thing lives in the template and name the
   external path. A path that never existed in this repository is a defect.

3. In those same five documents, make every reference of the form
   "<file> § <heading>" name a heading that exists in that file.

4. Read the template's docs/project/index.md. Where its document conventions
   differ from this repository's, choose one side and record the choice in
   docs/project/index.md, in the section that states conventions. A note that
   the two differ, with no decision, does not finish this deliverable.

5. Write docs/plans/2026-10-24-template-resync/00-log.md. One row per thing you
   changed or deliberately did not change: what was wrong, why, which files
   changed, and status (changed / left alone, because ...). Every file you edit
   appears in a row.

6. Leave archive/, other games reference material/, docs/official-docs-mirror-*/
   and the template untouched. Do not create files outside docs/ and the
   repository root.

If a deliverable would take you outside the scope, record it as "left alone,
because ..." in the log and move to the next deliverable. That is the correct
end state for that item, not a gap to chase.

When all six deliverables are done, emit exactly one line of the form

BENCH-DONE <ISO-8601 timestamp>

as the last line of an assistant message that also states, in at most five
sentences, what you changed and what you knowingly left alone. After that line,
stop. Do not keep editing after declaring done.
```

On the other device, substitute `C:\Users\TZ\Desktop\miliastra-game-template` for
the template path; that one path is the only text that may differ between the
two devices, and both arms on one device get identical bytes.

## Done criteria (what "current" means here)

These are the conditions the reviewer checks. They are stated as conditions,
not as a list of findings; the arm has to find which ones fail.

1. **Every index matches its directory.** For each index file in item 1, every
   file in its directory is listed and no listed file is absent.
2. **Every cited path in the five entry documents resolves**, except the
   sibling-relative form `../miliastra-game-template/<rest>` when `<rest>`
   exists in the real template checkout. Every other sibling-relative path is
   checked inside the arm.
3. **Every section reference resolves.** A sentence of the form
   `<file> § <heading>` names a heading that exists in that file.
4. **Conventions are reconciled, not merely noted** (item 4).
5. **The update log exists** at
   `docs/plans/2026-10-24-template-resync/00-log.md`, with one row per changed
   file and per deliberate non-change, each with a reason.
6. **The untouched shelves stay untouched** (item 6).

## Scoring hooks in the brief

- The `BENCH-DONE` line is the done declaration. Ordering is read from the
  session log, not from wall clock: the first assistant message carrying
  `BENCH-DONE` is the declaration event; every edit tool call after that event
  is **late-after-done**, counted once per file touched. File mtime is the
  fallback only for a run whose session log is unreadable.
- Criterion 5, the update log, is what makes "missing" countable: the reviewer
  diffs the tree against the log's rows.
- The scope is 74 files by construction; an arm that wanders past it is
  measurable as out-of-scope edits, and one that stops early is scored by what
  it missed, not by what it attempted.
