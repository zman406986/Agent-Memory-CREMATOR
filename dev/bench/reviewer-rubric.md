# Reviewer rubric — blind, counted, anchored

Two reviewers, each blind to arm identity. The operator supplies only what this
file names: two finished trees under `arm-A/` and `arm-B/`, the pre-run
`manifest.json` of each tree under its arm-letter name, and the session log of
each run under `<arm-letter>/session.v4.jsonl`. No arm name, no patch file, no
commit hash, no `racoons/` directory.

## Inputs the reviewer gets

| Input | Path given to the reviewer |
| --- | --- |
| Pre-run tree | `review/arm-<L>/manifest.json` |
| Post-run tree | `review/arm-<L>/tree/` |
| Session log | `review/arm-<L>/session.v4.jsonl` |
| Ground-truth gap list | `review/ground-truth.md` (written by the PM, not the operator) |
| This rubric | as given |

The reviewer writes `review/arm-<L>/score.md`. The operator joins the two scores
only after both are written.

## Metric 1 — missing updates (count)

Definition: an item on `ground-truth.md` that the arm neither changed nor
recorded in its update log with a `left alone, because …` reason.

- Count one per ground-truth row. A row is a row regardless of how many files
  it would have touched.
- `left alone, because …` counts as addressed (not missing) only if the reason
  names a real constraint: the template owns that fact, the item is inside
  `archive/`, or the item is already true. "Out of scope", "too large", and
  "would need a decision" do not count.
- An arm that changed a file but left the claim in it false still counts as
  missing.
- Report the number, then the row ids. A reviewer who cannot decide a row marks
  it `disputed` and reports it separately, never inside the count.

Score line: `missing: <n> (rows: <ids>)`.

## Metric 2 — late-after-done updates (count)

Definition: any edit tool call — `edit`, `write`, or a shell command whose
effect is a file write — whose `tool/call` event seq is **greater** than the seq
of the first `assistant/message` whose text contains `BENCH-DONE`.

- Count one per distinct file path touched after the declaration, not per call.
- A run with no `BENCH-DONE` has `late-after-done: n/a (no declaration)` and is
  scored as incomplete; metric 1 still applies.
- A `BENCH-DONE` inside a code fence still counts as the declaration.
- If the session log is unreadable, use file mtimes against the declaration
  time and say `source: mtime` on the score line. Never silently mix sources.

Score line: `late: <n> (paths: <rel paths>)` or `late: n/a (no declaration)`.

## Metric 3 — doc quality, 1–5, anchored

Score the whole finished tree, not one file. Each anchor is a description of
what the tree looks like; pick the highest anchor every clause of which is true.

| Score | Anchor |
| --- | --- |
| 5 | Every index in `docs/` lists every file in its directory and nothing absent. Every repo-relative path cited in the five entry documents resolves. Every `<file> § <heading>` resolves. The update log accounts for each changed file and each deliberate non-change, with reasons that name a constraint. No document outside the excluded shelves claims a forbidden pipeline or "the only workflow" while a second such file exists. Wording matches the repos' plain-language rule: short sentences, concrete words, no invented vocabulary. |
| 4 | As 5, except at most two dangling cites or one unlisted file remain, or the update log omits at most two changed files. Nothing in the tree is newly wrong; the gaps are omissions a careful reader would catch. |
| 3 | The main conventions are reconciled and most indexes are complete, but at least three dangling cites, unlisted files, or unreconciled convention conflicts remain — or the update log is a bare list of files with no reasons. No new false claims. |
| 2 | Some real fixes landed, but indexes and cross-references are broadly stale, or one forbidden-pipeline claim survives outside the excluded shelves, or the update log is absent. A reader following the docs would be sent to at least one dead end. |
| 1 | Cosmetic edits only, or edits that make a claim less true, or claims of work that the diff does not contain. |

Also record, separately from the score:

- `new-false-claims: <n>` — sentences the arm introduced that are not true of
  the tree. Any value above 0 caps the quality score at 3 and must be listed.
- `unlogged-changes: <n>` — changed files absent from the update log.

## Metric 4 — overall verdict line

Exactly one line, in this order:

```text
VERDICT arm=<L> missing=<n> late=<n|n/a> quality=<1-5> new-false=<n> unlogged=<n> note=<one sentence>
```

The note names the single most consequential thing the arm got wrong, or `none`.

## Rules the reviewer must follow

1. Do not open `key.txt`. Do not search the tree for a run id, patch file, or
   ledger path to infer the arm. If an arm is identifiable, stop and report
   `BLIND-BROKEN` instead of scoring.
2. Do not run the arm's code, the source repo's tools, or any git command that
   would need the source repo's history. Review is reading plus path checks.
3. Do not reward volume. A large diff that leaves ground truth untouched scores
   worse than a small one that lands it, because metric 1 dominates.
4. Do not consult the other reviewer or the operator's notes.
5. Review against the ground truth as given. If a ground-truth row is wrong,
   mark it `disputed` with one sentence of evidence; do not fix the list.

## The exact reviewer prompt

Send this verbatim, filling only the bracketed slots:

```text
You are a blind documentation reviewer for a two-arm benchmark. You will score
ONE arm. You do not know and must not try to learn which treatment produced it.

Inputs:
- Pre-run tree manifest: review/[ARM]/manifest.json
- Post-run tree:         review/[ARM]/tree/
- Session log:           review/[ARM]/session.v4.jsonl
- Ground truth:          review/ground-truth.md
- Rubric:                dev/bench/reviewer-rubric.md (read it in full first)

Do this, in order:

1. Read the rubric. Note the four metrics and the quality anchors.
2. Read the ground truth. For each row, decide: changed, recorded as left alone
   with a constraint reason, or missing. Count missing.
3. Compute the file delta between manifest.json and the post-run tree. List
   added, changed, deleted paths.
4. Scan session.v4.jsonl for the first assistant/message containing BENCH-DONE.
   Record its seq. Every edit/write tool call after that seq is late-after-done;
   count distinct paths.
5. Check the tree: every docs/*/index.md against its directory; every
   repo-relative cited path in AGENTS.md, CONTEXT.md, PRD.md,
   docs/project/index.md and the other docs/*/index.md files; every "<file> §
   <heading>" reference. Record each failure with its file and line. One
   exception: the sibling form `../miliastra-game-template/<rest>` is correct
   when `<rest>` exists in the real template checkout — check it there and do
   not count it as dangling. Every other sibling-relative path is checked
   inside the arm.
6. Score doc quality 1-5 against the anchors. List any false claim the arm
   introduced and any changed file missing from the update log.

Output: write review/[ARM]/score.md containing, in this order, the exact lines

  missing: <n> (rows: <ids>)
  late: <n> (paths: <paths>)        # or: late: n/a (no declaration)
  quality: <1-5> — <the anchor's first clause that decided it>
  new-false-claims: <n> (list)
  unlogged-changes: <n> (list)
  VERDICT arm=[ARM] missing=<n> late=<n|n/a> quality=<1-5> new-false=<n> unlogged=<n> note=<one sentence>

then, below those lines, the evidence: one bullet per ground-truth row, one per
dangling cite, one per index gap. Cite file and line. No prose outside bullets.

Do not open review/key.txt. Do not infer the arm from paths, commits, run ids,
or the presence of any tool directory. If you can identify the arm, stop and
write exactly: BLIND-BROKEN <what told you>.
```

## Joining the scores

The operator fills this table after both score files exist, then deletes
`key.txt`'s exposure from the report (numbers only, per ISSUE-018 §6):

```text
arm | missing | late | quality | new-false | unlogged | verdict
A   |         |      |         |           |          |
B   |         |      |         |           |          |
key | A=<arm> | B=<arm>
```

Primary metric for the bench result is `missing`; `late` is the ticket's own
headline ("updates landed after the done claim") and is reported beside it, never
folded into it. `quality` breaks ties and never overrides `missing`.

## Calibration material

Ember's re-sync (`44761e3e..1aca4400`) is the worked example of the same gap:
a pin gate landed first, then the pin itself overwrote a test suite, and the fix
landed afterwards with the gate as its check. Do not ship it with the reviewer
prompt — it shows what a complete fix looks like, which would bias the quality
anchors. It is for the PM who writes `ground-truth.md`, not for the reviewer.
