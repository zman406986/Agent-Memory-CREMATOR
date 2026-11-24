# Bench brief — the one task both arms get

This file holds the **exact task text** handed to both arms, word for word. The
launcher reads it with `--brief <this file>` and extracts the fenced block under
*Task text*; nothing else in this file reaches the agent.

Do not tune the task per arm. If a run needs a different task, that is a new
bench date, not an edit here.

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
  `docs/project/index.md`, `docs/guides/*.md`. These bind it.
- No subagent tools. The deny is structural (see `subagent-deny.md`), so the
  agent cannot delegate; it must carry the reading in one context.

## What the agent is NOT given

- No list of what is stale. Discovering the gap is the measured work.
- No instruction to re-sync `platform-free-core` by pin, and no mention of the
  template's pin gate. Discovering that route is part of the measurement.
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

Your job: find what in this repository needs updating to be current with the
template and with its own stated rules, and process those updates. This is mostly
documentation work: indexes, pointers, conventions, and any note that describes
something this repository no longer does or never did. Code changes are in scope
only where a document's claim cannot be made true without one.

Work through as much of the repository as you can. Prefer many small, correct
updates over a large rewrite, and keep every path you cite resolvable from the
repository root.

When you believe the repository is current, emit exactly one line of the form

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

1. **Every cited path resolves.** A repo-relative path mentioned in
   `AGENTS.md`, `CONTEXT.md`, `PRD.md`, `docs/project/index.md`, or any
   `docs/*/index.md` exists, or the sentence says it lives in the template and
   names it as an external path. A citation to a path that has never existed in
   this repository is a defect.

   The arms sit outside the source repo's Desktop neighbourhood, so the
   sibling-relative form `../miliastra-game-template/...` cannot resolve from
   the arm even though the repo law allows it. The reviewer resolves that exact
   prefix against the real template checkout and accepts it as correct; any
   other sibling-relative path is still checked inside the arm.
2. **Every index is complete.** For each `docs/*/index.md`, every file in its
   directory is listed, and no listed file is absent.
3. **Every section reference resolves.** A sentence of the form
   `<file> § <heading>` names a heading that exists in that file.
4. **No live document describes a forbidden pipeline.** Outside `archive/`,
   `docs/plans/`, `issue-tracker/resolved/`, `previous attempt/`,
   `prototype test/`, and `miliastra design plan/`, no document presents a
   toolchain, build step, or workflow the product rules forbid as the way this
   game is built, or claims to be the only workflow when a second such file
   exists.
5. **Conventions are reconciled, not merely noted.** Where this repository's
   stated document conventions differ from the template's current ones, one of
   the two is chosen and the choice is recorded in the shelf that owns
   conventions. A note saying "these differ" without a decision does not
   satisfy this.
6. **An update log exists** at
   `docs/plans/<today>-template-resync/00-log.md`, one row per item: what was
   wrong, why, which files changed, and status (`changed` / `left alone, because
   …`). The log is the reviewer's map; an unlogged change is a missing update
   for scoring.
7. **The untouched shelves stay untouched.** No edit under `archive/`, no edit
   under `other games reference material/`, no edit in the template, and no new
   file outside `docs/`, `issue-tracker/`, and the repository root.

## Scoring hooks in the brief

- The `BENCH-DONE` line is the done declaration. Ordering is read from the
  session log, not from wall clock: the first assistant message carrying
  `BENCH-DONE` is the declaration event; every edit tool call after that event
  is **late-after-done**, counted once per file touched. File mtime is the
  fallback only for a run whose session log is unreadable, and the rubric
  requires the reviewer to say which source it used.
- Criterion 6, the update log, is what makes "missing" countable: the reviewer
  diffs the ground-truth gap list against the log's rows and the tree.
- Nothing in the task says how many items exist. An arm that stops early scores
  by what it missed, not by what it attempted.
