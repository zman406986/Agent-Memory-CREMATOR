# Rules inventory — what the bench agents will read in the arm

Both arms hold a copy of this. Whatever these files say binds the agent while it
works, so the reviewer needs them in mind too: a change that obeys the rules and
a change that flouts them are not equally good updates.

Paths below are relative to the arm root. Sizes are from the source checkout at
`dc2b5bd` (2026-10-22).

## Root-level rule files

| File | Lines | What it demands of the agent |
| --- | --- | --- |
| `AGENTS.md` | 72 | The repo law. Names the shelf for every new file before it exists; forbids copy into `archive/`; requires a ticket before a fix; forbids bulk replace and tree-wide regex (they corrupt UTF-8 and CN strings); one writer per file; commits pathspec-limited; every shell command has a positive timeout; no CI; never kill the game; never publish a map; cite the one allowed sibling path (`../miliastra-game-template/docs/project/platform/ref-measurements.md`). |
| `CONTEXT.md` | 48 | Glossary plus path index. Defines the vocabulary (Mora, wave, structure, command base, client control, platform-free core, cloud-save variable, sprite, legibility gate) and an Avoid list. A doc edit must use these terms, not the avoided synonyms. |
| `PRD.md` | 341 | Product truth: surfaces S1–S6, wiring M1–M7, F/NFR/N/R ids. Every id cited elsewhere resolves here. Edits must not invent a new id or change a requirement's meaning. |
| `pipeline.md` | 294 | Claims to be "the only workflow" for implementing the game, and describes a pass pipeline driven by `pipeline/tracker.md`. This is a live claim, and it collides with what the repo actually does now. |
| `tracker.md` | 821 | "This is the only workflow file you need": find the first `[ ]` item, read that pass, do only that job, tick it, commit with `git add . && git commit`. The `git add .` instruction contradicts two laws above it. |
| `PROTOTYPE1_SUMMARY.md` | 82 | Describes the retired genshin-ts prototype as the build approach. Background, not law, but it states a toolchain the product forbids. |
| `API_MIGRATION.md` | 13 | Says the design docs in `miliastra design plan/` predate the toolchain and lists corrected API spellings. Applies only to that corpus. |
| `reminder.md` | 14 | Credits for third-party assets, including the genshin-ts compiler. |
| `bilibili_sub_BV1FiiFBxEGj.md` | 174 | A recorded video transcript used as reference. No rule content. |

## `docs/project/index.md` — the routing table

34 lines. Names three prefixes with binding force: `law-` is read before that
kind of work, `ref-` is opened only when the task touches it, `work-` is never
cited by a law or ref. Caps a document body at **150 lines** and requires the
split to update the index in the same change. This is the file that conflicts
with the template's current **250-line** cap, and it is the one the bench's
criterion 5 is about.

## `docs/guides/` — procedures

| File | What it demands |
| --- | --- |
| `law-editing-issue-files.md` | Ticket before fix; `NNN` numbering; a state move is one atomic change; an issue file is never deleted. |
| `law-writing-an-adr.md` | One decision per file, written before the change, permanent ids, an index row that mirrors the record's in-place `Law:` line. |
| `law-doing-design-work.md` | What may live under `docs/plans/`; a written rule belongs in `docs/specs/`; cites the measurement store rather than copying numbers. |
| `law-scrapping-clutter.md` | Deletes rules and checks agents invented; read before such a pass or before writing a rule that might become clutter. |
| `law-verification-non-vacuity.md` | A check that cannot fail is not evidence; break it, watch it fail, restore, watch it pass. |
| `law-restoring-exact-bytes.md` | `git checkout` does not restore committed bytes here (`autocrlf`); do not trust it to undo an edit. |
| `law-using-the-official-corpus.md` | How to use the copied official documents under `docs/official-docs-mirror-*/`. |
| `ref-corpus-*.md`, `ref-official-*.md` | Layout, keying, front matter, locale pairs, counts, region, tiering, and EN↔CN term maps for that corpus. |

## `docs/adr/` — decisions in force

Six records plus `index.md`. ADR-0002/0004/0005 are partly superseded by
ADR-0006 for their phase-gate clauses; ADR-0006 retires the phase gate and moves
the nine platform questions to `docs/project/platform/ref-platform-facts.md`.
An ADR is edited in place when its rule changes; the index's `Law` cell mirrors
that record verbatim.

## `docs/project/platform/` and `docs/project/building/`

- `platform/ref-measurements.md` (5 lines) is a pointer to the template's
  measurement store; `platform/ref-platform-facts.md` holds this repo's open
  platform questions.
- `building/` holds 13 `ref-` documents plus its index (Lua subset gate, sprite
  rect encoding, locale bundle parity, the `.gia` format and pipeline, a
  simulator recipe, and the phase-0 protocol cards). Two tool READMEs outside
  the docs tree — `tools/sprite_encode/README.md` and
  `tools/payload_bundle/README.md` — still cite the retired `ENGINE.md` name,
  and `building/ref-beyond-simulator.md` cites the retired
  `platform-facts-register.md`. All three are stale pointers, not live rules.

## `docs/project/sessions/`

`law-editor-sessions.md` and `law-editor-forensics.md`, plus an index sentence
that defers to "the template's `law-editor-forensics.md` and
`ref-shaping-laws.md`" — two bare filenames with no path. In the template, the
first lives under `docs/project/sessions/` and the second under
`docs/project/building/`, so the sentence resolves only after the reader adds a
prefix it does not give. Read before driving the editor; irrelevant to a
documentation-only run except as a cite defect.

## Outside the docs shelves, still binding

- `other games reference material/` is read-only. No agent writes there.
- `dev/lua-gate/run.ps1` and `platform-free-core/dev/run_tests.lua` are local
  tools; `AGENTS.md` calls the gate the authority for the Lua subset, not the
  local interpreter.
- `issue-tracker/open/` holds 26 open tickets at freeze time; `resolved/` holds
  52. The numbering law means a new ticket takes the next free number across all
  three states.

## Why the reviewer cares

The bench measures documentation currency, so the reviewer must separate:

1. **A real update** — a stale pointer, an incomplete index, a convention
   conflict reconciled, a forbidden-pipeline claim retired.
2. **A rule-breaking edit** — a bulk rewrite that mangles CN text, a new file
   with no named shelf, a rewritten ADR that changes a decision, an edit under
   `archive/`, or a `git init` inside the arm (there is no repository there, and
   creating one is a defect, not progress).
3. **A no-op disguised as work** — a note saying "these differ" where criterion 5
   asks for a decision.

Category 2 is never quality; it caps the score and is listed under
`new-false-claims`. Category 3 counts as missing.

## The exclusion list, confirmed

Measured with a scan on 2026-10-22 against `dc2b5bd` (working tree 107 MiB
including `.git`):

| Dropped | Size | Files | Why |
| --- | --- | --- | --- |
| `.git/` | 59.4 MiB | 1933 | Named by the ticket. |
| `dev/beyond-simulator/node_modules/` | 43.6 MiB | 278 | Named by the ticket. All 278 are **tracked** in the source repo, so a naive `git archive` would have shipped them. |
| `build/` | 1.6 MiB | 3 | Build output; gitignored in the source repo and still present on disk. |
| `scratchpad/` | 0.9 MiB | 43 | Disposable by the source repo's own law, never cited. |
| `__pycache__` (2 dirs) | 0.2 MiB | 14 | Python cache. |
| Files over 5 MiB | 36.6 MiB | 3 | `badapple.lua` 14.8, `Bad Apple 完整版.gil` 14.9, `assets.swf` 5.2 — all inside `other games reference material/`. |

Resulting arm: **1787 files, 20.1 MiB**. No `wheels/` directory exists in
Taskworld-Project at all; the owner's wheels live under the template's
`scratchpad/`, which this source does not contain.
