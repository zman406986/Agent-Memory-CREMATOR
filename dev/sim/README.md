# dev/sim — public-seam bank selftest

`bank-selftest.mjs` re-expresses the v4 simulation bank's selftests on the promoted `@cremator/core` seam. The
scratchpad bank built recall manifests from dist modules and served archives from its own Maps; this file imports
only public package exports. It proves:

- **byte-exact restore** — two halves, named so neither is mistaken for the other: (1) a RENDERER AGREEMENT —
  the `Guard`-prepared archive's bytes equal the node's own bytes, both produced by the same renderer; and (2) a
  REAL RESTORE CHECK — the archive is prepared into a real `SqliteLedger` + `FileBlobStore` pair in a temp dir,
  and `ledger.recall(id)` returns those exact bytes, re-verified span by span and by sha256, decoded back to the
  original Unicode text. The first half cannot catch a renderer bug; only the second proves the store round-trips.
- **durability** — the same recall id is served after closing and reopening the ledger.
- **receipts** — the guard's appended receipt record equals `receiptLine` rendered from the same facts:
  `lines 1–2, 5–6` for a kept middle span, the floor shape for a whole-unit removal.
- **refusals** — an unknown or malformed recall id throws the shipped `LedgerError` with code `not-found`; a
  tampered blob throws `hash-mismatch`.
- **id stability** — identical bytes under one session keep one recall id; a different session changes it.

Run (the core build must exist first):

```sh
npm run build -w @cremator/core
node dev/sim/bank-selftest.mjs
```

It imports `@cremator/core`, never `packages/core/src` or a dist path. Named gaps: `recallIdFor`,
`buildRecallManifest`, `manifestSha256` and `renderRecords` are not public exports, so an archive can only come
from the shipped `Guard` path; this file does not reimplement them. The authoritative harness remains the
gitignored scratchpad bank (`scratchpad/spike-008/v4/`); this file pins the public-seam contract that outlives it.

## gate2-tables.mjs — gate 2 on the table lane, bound to the shipped core

`gate2-tables.mjs` recomputes every frozen table prefix of a dry table-lane run (`run-v4-full.mjs` artifacts) and
asserts recompute, epoch extension and same-turn equality, epoch bases, rendered receipts, arm-pair identity and
non-vacuity. The recompute engine is the product's, not the simulation's: the gate imports the built core entry
(`<DIST_ROOT>/index.js`) and rebuilds with the shipped `renderHistory`, `receiptLine`, `appliedSetAt`, `epochsFor`,
`canonicalRanges` and `sha256Sync`; it re-derives the epoch plan with the shipped `epochsFor` and compares every row's
`epochKey`/`epochIndex`/`epochBase` and every summary epoch record against it (`epoch-plan`), so a sim-vs-product
divergence reddens the gate; it is no longer a check of the sim's own builder. Tracked note:
`docs/research/gate2-shipped-binding-2026-10-24.md`.

**What remains sim-only** (gate header and note): the turn-block parser and unit catalogue (`loadBundle`,
`renderPristineSegment`); the receipt splice (one receipt per removed line gap, whole-unit renders as the receipt
alone); recall-id minting (the dist manifest builders are not public exports, so the simulated bank mints them);
and the table-ask composition and fork appends (gate 1's surface).

**Frozen dist.** A run and its later gate must read the same build. Freeze the HEAD build once and pin both through
`CREMATOR_SIM_DIST`:

```sh
npm run build -w @cremator/core
cp -r packages/core/dist scratchpad/spike-008/v4/.dist-head-2026-10-24
CREMATOR_SIM_DIST=scratchpad/spike-008/v4/.dist-head-2026-10-24 \
  node scratchpad/spike-008/v4/run-v4-full.mjs --out scratchpad/spike-008/v4/out-tables-head-2026-10-24
CREMATOR_SIM_DIST=scratchpad/spike-008/v4/.dist-head-2026-10-24 \
  node dev/sim/gate2-tables.mjs --out scratchpad/spike-008/v4/out-tables-head-2026-10-24
```

The note's numbers are from the HEAD build at commit `fcad5e5`, frozen 2026-10-24. The gate exits 0 green on that
artifact set:

```
gate2-tables: GREEN — 58 table prefixes recomputed and matched, 52 epochs chained, 31 applied receipts rendered
```

`--flip '<sessionId>#t4'` exits 1 red by name:

```
gate2-tables: RED — recompute-sha×2 no-extension×1 epoch-base×1
```

The same-turn lane (`--session sess_109bc295-… --units-limit 40`) is 8 prefixes, 4 epochs, 18 applied receipts;
flipping `#t4` there gives `RED — recompute-sha×2 same-turn-break×4`. The gate refuses (exit 2) when a dist module
no longer hashes to the value the run recorded: a stale artifact set from before a rebuild is a named refusal, not
a red gate. The harness (`scratchpad/spike-008/v4/lib/`, overridable with `--harness`) is now only the input model
and the recall-id minter; the recompute path does not call its builders, and missing inputs are a named blocker,
never a green run.

## gate1-fork-cache.mjs — gate 1 on the fork/table ask shape

`gate1-fork-cache.mjs` is Ruling 7's live 3-call cache smoke, written as an executable check for the fork the mount
actually grows: a judge/prune table ask is appended as a user turn over main's untouched system slot, the answer
as an assistant turn, then the next ask. The ask bytes come from the shipped `tableAsk`
(`<adapter dist>/judge-tables.js`); the fork grows through the shipped `seedFork`/`appendAsk`/`appendVerdict`.
Shape source: `dev/dsh-rig/scenarios/prune-apply-auto.json` (judge lane 2 rows, prune lane 1 row).

**Pass criterion** (ISSUE-035 item 3, Ruling 7 gate 1): calls 2 and 3 each byte-extend call 1's message-array
prefix, and the provider reports cache-read tokens > 0 on both calls. Cache reads are read from
`usage.prompt_tokens_details.cached_tokens` only: `prompt_cache_hit_tokens` was absent on the 2026-10-23 probe but
present on all three 2026-10-24 calls (3456/4224, equal to `prompt_tokens_details.cached_tokens`), and the gates
read that field alone by design; TOP-LEVEL `cached_tokens` is 0 on all three calls and is a dead signal.

**Offline by default.** `--plan` builds the exact three payloads, asserts the prefix relation and shipped-ask
markers, prints the plan and criterion, and exits 0 without a socket. It needs a core build and an adapter build
(`npm run build -w @cremator/core && npm run build -w cremator-dsh`), or a frozen adapter copy via
`CREMATOR_ADAPTER_DIST`.

**Live is a pending human gate.** `--live` refuses unless `--owner-authorized` is also passed; even then the
owner's live-run authorization starts it. It makes at most 3 calls, arms a kill timer (default 300 s,
`--kill-timer-s`), reads `DEEPSEEK_API_KEY` in-process from `~/.dsh/.credentials.yaml` (never printed or exported),
aborts on the first call error, and writes raw usage to `scratchpad/gate1/<yyyy-mm-dd>/` (gitignored). It prints
PASS/FAIL per criterion and exits 0 only on PASS.

Why the fork shape: the 2026-10-24 epoch smoke (commit `064acd6`) byte-extended the last message in place and read
0 hits; the ISSUE-026 probe measured that in-place shape at 0.0% and the append shape at 92.0%/96.1%
(`scratchpad/spike-008/v4/probe-fork/2026-10-23/evidence.md`). This file records no live result; the run's
evidence is.

## sim-batch-units.mjs, sim-batch-report.mjs and sim-batch-live.mjs

The host runs a tool-result pruner of its own; ADR-0041 makes it off in every LIVE measurement run because it is a
competing mechanism. `sim-batch-live.mjs` under `--transport stub` is an offline replay lane, not a live run. ONE
INVOCATION IS ONE ARM: the runner takes `--ignore-host-prunes` (the product arm — the recording's prune rows leave
the world) or `--allow-host-pruner` (the vanilla arm — the recording's own prunes are replayed); both or neither
refuses by name. A host-vs-product pair is two invocations, never one run with two arms inside it.

**Default input and the floor.** The default transcript is the 2026-10-29 full-rerun vanilla world, session
`fab6632e`, with its `evidence/result.json`; it was picked for ADR-0045 because it carries the agent's reasoning.
The session file is FOUND under the world root, never rebuilt from the host's label: `CREMATOR_SIM_EVIDENCE` names
the root (default: the path above) and its one `session.v4.jsonl` is taken; an absent or ambiguous root is a named
absence. `SEGMENT_PINS` also pins `transcriptSha256` and `usageSha256`, the two files the numbers came from: a
segment-139 claim that names no input, or whose hashes differ, refuses (`sim-batch-pins-input-absent`,
`sim-batch-pin`) — a recording edited consistently with its counts moves both prompt and ruler, and only the file
hash sees it. The transcript hash must be the one `readTimeline` computed from the bytes it replayed: a timeline
built from a ROW ARRAY carries no file hash and refuses a pinned claim
(`sim-batch-pins-rows-unpinned`), so rows from one file plus the pinned hash of another cannot pass. These two
bindings are checked on EVERY segment, not only at 139 (P2): a stated transcript hash must be the timeline's own,
and a stated usage hash must name a `usageFile` whose recomputed hash equals it
(`sim-batch-pins-input-mismatch`, `sim-batch-pins-usage-unpinned`); the 139 block then compares both to
`SEGMENT_PINS`. The floor is
**512 B**: `FLOOR_BYTES` CALLS the product's `floorForModel("deepseek-flash")` at load (`deepseek-flash` is not in
the per-model table, so core's default applies), so the number moves with the product instead of being copied. The pins are
`fab6632e@139`: **268 eligible units** (201 appends + 67 host replacements), 67 prune journals, HOST peak 315,197 at
139, 19 tools (13,290 B header, 13,879 B as the request's array), **86 reasoning turns / 155,545 B**, and the two
structural counts, **93 content parts / 93 stream entries**. The whole FILE, not the segment cut, carries
**271 content parts / 271 stream entries**; both pairs are read structurally and BOTH are pinned — the segment's
93/93 and the file's 271/271 (P8) — and `reasoningTurns` (86) EQUALS `reasoningBlocks` on every transcript BY
DEFINITION (both are read off the same `type:"reasoning"` parts after the unresendable gate), so that equality is
not a check. The reasoning gate that can fail is the COVERAGE floor: `reasoningTurns / assistantTurns` below
`REASONING_TURN_COVERAGE_FLOOR` (0.55) refuses `sim-batch-reasoning-coverage`; the pinned world reads 86 / 139 =
0.6187. The older 372 and 1,084 were
SUBSTRING counts of `"type":"reasoning"`: each part occurs four times in the serialized row (the content part, the
replay-state block, the stream block-start's block, and the stream's `replayState` block), so 372 = 4 × 93 and
1,084 = 4 × 271. The pruner-off pins are 201 appends, no journal, no replacement, and a reconstructed peak of
**565,538 tokens at step 138**, policy-free.

**The ask stream is time-aware: a unit is tabled while the surface holds it.** A host prune
removes a row at the prune journal's own step, and the predicate is STRICT
(`hostRemovedAt(timeline, fireStep)` = every prune whose owning step is `< fireStep`): the product
runs a step's entry ask AFTER every queued result has landed and BEFORE that step's prune sees
the step (`plugin.ts:2144-2145`), so a fire landing on a prune's own step still tables the rows
that prune names, and they leave the next prompt. An original pruned at step 100 WAS on the
surface at a fire at step 100 and is askable there. The plan and `runLane` table every eligible
unit that had not been removed by the fire, and `assertBatchInPrompt` refuses a batch carrying an
unrendered seq (`sim-batch-batch-unrendered`). The same rule credits a shape applied on an EARLIER
step than a later host prune: its removal counts for the window it stood, and the depth series
stops subtracting it at the prune step. Only a unit whose host prune is owned by a step STRICTLY
BEFORE its own landing step is never askable.
Where each number lives: the PLAN summary and JSON carry `eligibleResults`, `askableResults`,
`hostPrunedEligible`, `askableBeforePrune`, `hostPrunedBeforeLanding`, `prunedBeforeAsk` and
`carried`; the RUN summary carries `eligible`, `askable`, `eligibility`, `askableSplit` and the
same host-pruned counts plus `carried`; a SEND RECORD carries `batchSize` (the rows it tabled) and
`eligibility`, and no send-record field counts a unit as asked. There is no `asked` field anywhere,
and no field asserts `asked + carried = askable`: `asks` counts FIRES, not rows.

**The eligible population is stated on every record.** Every send record, the run summary and the plan summary
carry `eligibility: { floor, rule, eligible, excluded }`: the floor, the rule
(`readable text && bytes >= floor && !isError && !nonTextContent && factsShowTwoQuotes`), and one count per
failing test (`unreadableContent`, `nonTextContent`, `belowFloor`, `errorResult`, `noTwoQuotes`; each unit counts
once, under its first failure).
`unreadableContent` is a row that DECLARES a non-empty string body, which `textOf` does not read: its 0 B is a
reading gap, never a small body (P7). `nonTextContent` is the same reading gap for a PARTS body with no text part
at all (an image-only tool result): it declares content but `textOf` reads 0 B (thirteenth audit item 3). The
`[summary]` line prints all five counts
(`N unreadable-content, N non-text-content, N below-floor, N error-result, N no-two-quotes`), as the JSON has always carried them.
`errorResult` is the PRODUCT'S own rule too: the failure drop is in `plugin.ts`'s `observe` (`:1766,1831`), fed by
`toolResultItem` (`:1090-1094,1114`), which reads `isError` and journals `skip`/`failed-result` and returns null
before the entry seam ever sees the row. So the sim's `!isError` is the same population rule, not a narrower
sample. The count is a population split and is NOT a citation reason (P9 removed the false
`sim-only-eligibility:error-result` blocker).

**Test class.** `sim-batch-units.mjs` and `sim-batch-report.mjs` are offline analyses; `sim-batch-live.mjs` is the sim test (`docs/project/ref-glossary.md`).

- **Default.** A `compaction/prune` row is a FIXED removal that takes effect at the step AFTER the prune's own
  step: its shadowed seqs go into `hostRemoved`, the append leaves the surface from that next step on, and the
  replacement row enters at its OWN entry step (never the prune's). A unit pruned LATER is askable before the
  prune, and a shape the policy booked before it is credited for the window it stood. A unit already removed at a
  fire is NEVER TABLED — it is filtered before the table, so it is never asked and never credited; the branch that
  would have "asked it and credited nothing" was unreachable and is deleted. A unit whose prune is owned by the
  fire's own step IS tabled (the ask runs before the prune), and its shape lands on the prune's step, so it frees
  no window and is credited nothing (`sim-batch-booking-sum` proves the two readings agree).
- **`--ignore-host-prunes`** takes that mechanism out: `hostPrunes`, `hostRemoved` and `hostTokens` are empty; the
  prune rows and their replacement rows leave the unit stream and the surface; the originals stay whole. The
  skipped counts ride the timeline and plan as `hostPrunesIgnored`, `hostTokensIgnored` and
  `hostReplacementsIgnored`, and the summary line names them.
- **A pruner-off lane triggers on the reconstructed surface only.** `result.json`'s series was measured with the
  host trim active, so it is recorded as `hostDepths` with `contaminated: true` and never triggers a pruner-off
  lane (`sim-batch-depth-contaminated`). Every pruner-off trigger and depth is the surface's own bytes at 3.04
  B/token; every ratio-derived ESTIMATE uses 3.04. The pre-send guard is `ceil(bytes/3)` applied to the LARGER of
  the content-only count, the messages+tools payload and the full request body (`promptGuardTokens`). The three
  bounds have distinct names: `promptGuardTokensContent` (content), `promptGuardTokensPayloadWire` (the
  messages+tools JSON `buildPrompt` builds) and `promptGuardTokensBodyWire` (the full request body, envelope
  included); `promptGuardTokens` is their maximum. A PROVIDER's `prompt_tokens` is recorded as reported; the STUB's is this
  sim's own estimate fed back, so it carries `usage.ruler: "synthetic"`, its band counts in `fidelitySynthetic`,
  and `fidelityWarnings: 0` on a stub run states only that no PROVIDER band was graded — never a pass.
  The RUN summary names its one ruler (`usageRuler`: `"provider"`, `"synthetic"`, or `"mixed"`) and keeps the two
  books apart: provider readings sum into `promptTokens`/`completionTokens`/`totalTokens`, and synthetic readings
  sum into `estimatedTokens` with those provider totals left at 0. A stub run therefore reports
  `usageRuler: "synthetic"` and its totals under `estimatedTokens` — a synthetic number is never presented as a
  billed one (twelfth audit item 9).
- **The fidelity anchor is the request, not the trigger's ruler.** On the surface path the anchor is
  `measuredTokensOf(promptWireBytes)`: the FULL request body's estimate (framing, role keys, escaping, the
  `reasoning_content` key, the tools array, the `model`/`stream`/`stream_options` envelope and the ask all
  included), with `anchorBasis: "surface-request-body"`. It used to be the content-only surface depth plus the
  ask bytes, which omitted everything framing-related while calling itself "the request" (P4). `anchorSource`
  names the series (`reconstructed-surface` or `host-result.json`); on the host path `anchorBasis` names what
  was added to that reading (`host-result-json-at-fire+ask+step-units`: the ask plus EVERY unit that landed at
  the fire's own step, because the measured depth at that step is the request that PRODUCED those results and
  cannot contain them). `anchorAddedUnits` / `anchorAddedUnitTokens` record the addend, so a step with two
  results is counted for both (P7). A correction send's anchor is additive — the first send's anchor plus the
  grown bytes — so its `anchorBasis` is `first-send-anchor+correction-delta` and its `anchorDeltaBytes` /
  `anchorDeltaTokens` state the delta; it never inherits the first send's basis word. `triggerDepth` stays the
  cadence's own reading, unmodified.
- **The live band runs on the route's measured ruler, never the stale 3.04 estimate.** Ask 0 has no band:
  the 3.04 B/token anchor was measured on an earlier route, and the official DeepSeek route tokenizes near
  4.0 B/token, so banding against it refused a correct body (pilot 2026-11-07: 56,416 B / 14,110
  `prompt_tokens` = 4.00, read as 23.97% off an 18,558 anchor). The first accepted live send records
  `tokenRuler {bytesPerToken, fromAsk, providerPromptTokens, promptBytes, toolBytes, textBytes,
  source: "first-send", points: [ask 0], solved: null}` on the run summary; its ratio must fall in
  **2.0-6.0 B/token** or the run refuses `sim-batch-provider-ruler` naming both numbers. Ask 1 is banded
  ±25% against `anchorBytes / bytesPerToken`, then becomes the second calibration point. Ask 2 and later are
  banded ±25% against the **two-density prediction** `toolBytes/rTool + textBytes/rText` solved from asks 0
  and 1, where `textBytes = sentPromptBytes - toolBytes`. **The band is a gross-error guard** for a missing or
  doubled context: a send more than 25% off refuses `sim-batch-provider-band-gross` naming the delta and both
  numbers, and a send 10-25% off records `tokenRuler.drift: "within-gross-band"` and continues. Exact content
  identity is established by the prompt bytes sent and the body hash checked before send, not by the
  provider's tokenizer: one ratio is a mix of the constant tool schema and the shrinking text, so it drifts as
  removals land (second pilot 2026-11-07: +2.95%, +3.38%, +4.83%, +7.17%, +10.74% and a refusal at ask 5
  under the old ±10% band); the two densities put the same six sends inside ±10% (`rTool ≈ 5.03`,
  `rText ≈ 3.75`). Every send record carries `tokenRuler {rTool, rText, solvedFrom,
  predictedTokens, providerPromptTokens, deltaPercent, drift}` (`deltaPercent` is reporting only, and `drift`
  is null outside the 10-25% region) and both stale estimates beside it: `anchorDepth304`
  (the old 3.04 estimate) and `anchorDepth` / `anchorDepthCalibrated`, with `anchorRuler` naming the model
  (`estimate-3.04`, `first-send`, `two-point`). A degenerate solve (no tool bytes, no text, dependent
  points, or a non-positive ratio) falls back to the single ratio and records `rulerFallback: true` plus
  `fallbackReason`; the summary keeps `tokenRuler.solved` / `.rulerFallback`. A synthetic reading never
  calibrates (`usage.ruler: "synthetic"`), so the stub path is unchanged, and a body at the scale of a
  missing or doubled context still fails the gross band. The non-live probe path keeps the pre-pilot ±10%
  band, as a recorded warning. A REFUSED run (exit 2) writes a partial `<lane>.json` with
  every field it knew, `refused: true`, `refusedAtAsk`, the refusal verbatim, the live summary at the
  refusal, and the records written so far; the artifact exists even when the run never reached ask 0.
- **Two prompt sizes, never conflated.** `promptBytes` is message content plus the tools JSON: a CONTENT-ONLY
  count, neither bound on the wire, because it includes the stand-in's invented lines and omits framing, keys and
  escaping. `promptJsonBytes` is the messages+tools payload and `payloadWireDeltaBytes` (in `buildPrompt`) is
  `payload − content`. The send record's `promptWireBytes` is the FULL request body, envelope included, and its
  `bodyWireDeltaBytes` is `body − content`: a distinct name, because the two deltas subtract different payloads.
  The 400k guard reads the larger of ALL THREE counts — the content-only count, the messages+tools payload and
  the full request body — and `promptGuardTokens` is that maximum; the summary keeps `promptPeakWireBytes`
  beside `promptPeakBytes`.
- **A usage row must say where the cache sits, and the series must have no holes.** `readUsage` computes depth as `inputTokens + cacheReadTokens`
  only when the row STATES the additive shape — `inputTokensIncludeCache: false`, or a provider prompt count
  (`promptTokens`, the wire's `prompt_tokens`, or the real result.json's `billedTokens`) equal to
  `inputTokens + cacheReadTokens`. Total arithmetic alone is not a statement (P8): a row whose `inputTokens`
  contained the cache and whose total added it a second time passed every total guard and inflated the depth by
  exactly the cache count; it now refuses `sim-batch-usage-cache-shape-unstated`. A stated prompt count that
  matches neither shape refuses `sim-batch-usage-prompt-mismatch`. A row with `cacheReadTokens > 0` and no
  `totalTokens` refuses (`sim-batch-usage-total-absent`) UNLESS it states the folded shape; a total is never
  mandatory for a row with no cache. A cache-bearing row with no `outputTokens` refuses unless it states the
  folded shape (`sim-batch-usage-output-absent`). The folded shape is
  `inputTokensIncludeCache: true`, whose depth is `inputTokens` and whose total — WHEN PRESENT — must equal
  `inputTokens + outputTokens` (`sim-batch-usage-total-mismatch`); the folded shape without an `outputTokens`
  count accepts only a total equal to `inputTokens`. The two TOTAL guards run on EVERY row, cache-bearing or not
  (P4): a total equal to `input + output` while a cache is present refuses (`sim-batch-usage-cache-included`; the
  check is vacuous at `cacheReadTokens: 0`, where no cache exists to double-count), and a total that is neither
  `input+output` nor `input+cache+output` refuses (`sim-batch-usage-total-unexplained`) — so `{inputTokens: 502,
  cacheReadTokens: 0, totalTokens: 9_999}` refuses instead of reading depth 502. A row with `cacheReadTokens: 0` is
  validated too (P5): with no cache the two shapes coincide, so a stated prompt count must equal `inputTokens`,
  and `{inputTokens: 502, prompt_tokens: 9_590, cacheReadTokens: 0}` refuses
  (`sim-batch-usage-prompt-mismatch`) instead of passing with depth 502. A PRESENT but invalid prompt count —
  negative, fractional, a string, or past `Number.MAX_SAFE_INTEGER`, under any of `promptTokens`,
  `prompt_tokens` or `billedTokens` — refuses `sim-batch-usage-invalid`; it is never read as an absent count
  (twelfth audit item 8). Every row also names a REAL step (P3):
  `step >= 1`, `inputTokens >= 0`, and a present `outputTokens`/`totalTokens` non-negative — a zero or negative
  step names no request and refuses (`sim-batch-usage-invalid`). The series is then pinned to the transcript:
  every depth step must be a `step/start` step of the recording (`sim-batch-usage-step-unpinned`), AND every
  `step/start` step in scope — up to `--segment` when the run is cut — must HAVE a reading, or the run refuses
  `sim-batch-usage-step-hole` (P5: a series that skipped a declared step used to pass, and the trigger ran on a
  ruler with a hole). A transcript that declares no step boundary at all cannot pin any reading and refuses the
  same way. Every reading records `shapeBasis` — `no-cache`, `prompt-count`, `totals`, or `statement` when only
  the row's own `inputTokensIncludeCache` field says where the cache sits. The summary's `usageSteps` lists those
  `statedOnlySteps`, and a run with any carries `usage-shape-unverified:<n>` instead of trusting the statement
  silently (P5).
- **A cut-off stream is not an answer.** `classifyStream` returns `stream-truncated` when the SSE reader never
  saw `[DONE]` (`done !== true`), the class the product maps from `entry-ask.ts` — UNLESS the stream already
  tripped a length limit: a `finishReason` of `length`/`max-tokens` is `length-trip` and is checked FIRST, so a
  length trip wins over a missing `[DONE]`. Text and a `finish_reason` on a socket that ended early are a partial
  answer, never an answer.
- **The carry gate compares the BODY, byte for byte.** `assertCarriedOverrides` reads `buildPrompt`'s `turnSeqs`
  and requires every carried seq's message to equal `"<label>:\n" + surface.get(seq)` exactly, and every
  non-carried unit turn to equal `"<label>:\n" + unit.text`. A surviving marker line no longer passes: one changed
  summary byte refuses `sim-batch-carry-body-mismatch` and names the first differing byte.
- **`tableSource` says which body a fire tabled.** Under `--ask-scope new` a fire tables the landed text
  (`tableSource: "landed"`); under `--ask-scope kept` it tables the SHAPED body the prompt carries
  (`tableSource: "shaped-surface"`), because the product re-reads the shaped node. The row's line count and
  ranges are the shaped body's.
- **`--ask-scope kept` has NO PLAN.** `planLane` and `thresholdLane` take no `askScope` argument (eleventh audit),
  so `--ask-scope kept` is a LIVE-runner option only: there is no planned fire schedule, no planned removal
  booking and no plan-vs-live equality check for the kept scope. A run that wants that comparison must run
  `--ask-scope new`. (Implementing a kept-scope plan was not done here; this paragraph is the statement of the
  gap, not a promise.)
- **`triggerDepth` follows `depthSource`.** A host-source batch lane records the measured depth at the fire's own
  step net of earlier removals; a pruner-off lane records the reconstructed surface's own depth, never the
  contaminated host series.
- **The build identity names the code and refuses a hole.** `build` carries the node version, both package
  versions, the core dist hash and the hashes of `units`, `grammar`, `render`, `gate3` (and `live` on the runner).
  An unreadable module or dist is `sim-batch-build-invalid`, never a recorded `null`.
- **Inputs are read once and hashed from those bytes.** `readTimeline` reads the transcript file ONCE, hashes that
  buffer, then decodes and parses the same buffer; `sim-batch-live.mjs` reads the usage file once, hashes those
  bytes and parses the same text, and the run output's `input` block reports the timeline's own
  `transcriptSha256`, its `fileRows`, and that one usage hash. A changed second read cannot enter the pin. The
  `readBytes` option is the test seam that proves the reader makes exactly one call (twelfth audit item 7).
  The PLAN launcher does the same (thirteenth audit item 5): `main` passes its `readBytes`/`readText` seams to
  `readTimeline`/`readUsageOf` and builds `input` from `timeline.transcriptSha256` plus the usage hash that
  `readUsageOf` computed from its one read, never from `inputPinsOf` (which would re-read both files).
- **The answer is stored, not summarized.** Every send record carries `contentText` (the joined answer
  text, capped at 256 KiB), `contentSha256` over the WHOLE answer, `answerTruncated`, `contentBytes` and the
  400-byte `contentHead` / `contentTail`, so the parsed rows and the freed bytes can be re-read from the
  record instead of a slice (fourteenth audit item 1). A capped answer keeps both ends and its hash still
  commits to every byte the record did not store.
- **A failed correction applies nothing.** The one correction send failing makes the whole fire unanswered:
  no row is applied (an arithmetic-invalid first-pass row can never shape the surface), the surface does not
  move, `unansweredFires` counts it, and `correctionFailedFires` / `correctionFailedRows` count the refusal;
  the record states `correctionFailed` and `unappliedRows` (fourteenth audit item 3).
- **An ANSWERED reply with no text is a row-level KEEP, never a failed send.** A transport-answered send
  (http 2xx, stream done) whose reply carried no readable text — a reasoning-only answer, an empty answer, a
  tool-call-only answer — is a MODEL answer. The product refuses it `no-text` (`llm-ask.ts:314`, renamed
  `empty-text` by `entry-ask.ts`) and every tabled row keeps (`batch-ask.ts:197`; `plugin.ts` journals one
  `entry-ask-refused` per row), and the next landing forms the next batch. In batch mode the sim does the same:
  the REAL reader refuses every tabled row with its own code, nothing is applied, the surface does not move (the
  row stays whole and is never re-tabled in the run), and the fire is counted `unansweredFires` beside
  `parseRefusedFires` / `parseRefusedRows`. Its record states `parseRefused: true`, `failureClass: "parse"`,
  `refusedRows` and `unappliedRows`; it is NOT a `refusedSends`, NOT a dropped batch and NOT `carried` (the rows
  were asked). The rows still count in `refused-rows:<n>`, so the run cannot read `complete`. A reply that HAS
  text but whose every row the parser refuses takes the same route through the parser and counts the fire in
  `unansweredFires` too. A TRANSPORT failure — a non-2xx status, a stream that never reached `[DONE]`, a
  deadline — is not a model answer: the transport states `answered: false` and the lane still stops
  (`refusedSends`, the batch `carried`). A `length-trip` (a token-cap cut) keeps its own class and still stops.
  Threshold mode is unchanged and still stops on every failed send.
- **Refusal classes are two maps, and a row refusal is never a send refusal.** `refusalClasses` books refused
  SENDS under their `failureClass` (a non-2xx, a cut stream, a deadline); `rowRefusalClasses` books refused ROWS
  under the reader's own code (`spans-outside-result`, `answer-unreadable`, `action-not-in-grammar`,
  `missing-index`, ...). Every record that carries `rows` states its own `rowRefusalClasses`; a failed send has no
  rows, so its record states `{}` and only the send map moves. The row map's counts sum to the summary's
  `refused` by construction, so a reader can classify a run's refusals without walking `records[]` (ISSUE-184).
- **A shadowed seq is an integer.** `readTimeline` refuses `sim-batch-shadowed-seq-invalid` for a non-array
  `shadowedSeqs` or any non-integer entry: `"7"` matches no row key, so the prune would count as one and
  silently shadow nothing (fourteenth audit item 4).
- **Ask totals are checked at every fire, as a guard.** `assertAskTotals` runs after each
  `askAndApply` (and once at the end), and refuses a lane that produced no ask. Its
  `asks !== triggers` branch CANNOT fire in today's code: the two counters move in the same
  `fireOf` path, and a failed send still counts as an ask. The branch is kept as a guard against
  a future path that increments one count without the other, not as a reachable class. The catalog
  `CHECK_CLASSES` (`sim-batch-units.mjs`) is the DOCUMENTATION and marks it `definitional` (two
  counters in one path); it marks `reasoning-turns-equal-resendable-blocks` `definitional`, the
  pruner-off zero `not-applicable`, and three gates that can pass on an empty population (an empty
  decision log, a zero-reasoning transcript, and a fire carrying no shaped seq) `not-applicable`
  (thirteenth audit item 6). The run's own field is NOT the catalog (fourteenth audit item 5):
  `measurement.checks` is `checkOutcomesOf`'s list, one `{name, class, outcome, count, countName}`
  per class, where `outcome` is `measured` when the comparison ran over a non-empty population as
  an independent reading, `definitional` when it agrees by construction over a non-empty population
  (the two checks above, matching the catalog), and `not-applicable` when it compared an empty set
  with itself; `count` (named by `countName`) is the reading that decided it — `asks`,
  `reasoningTurns`, `replayedPrunes`, `decidedRows`, `reasoningMessages` or `carriedOverrides`. No
  reader may count any of the six as a passing measurement.
- **The surface gate compares a digest rebuilt from the decision log.** After every successful
  fire `assertSurfaceAdvanced` checks the fire stamp, the surface's CURRENT size (`surfaceSizeOf`)
  against the size of the surface `reconstructedSurfaceOf` rebuilds, AND `surfaceDigestOf` against
  that rebuild's digest — an expected surface rebuilt from the run's DECISION LOG and the landed
  unit texts. The independence is at the BOOKKEEPING layer: the rebuild re-derives which unit each
  decision names, at which fire, and the carry set from the decision log, instead of reading the
  writer's own map. It is NOT an independent renderer — both the rebuild and the writer call
  `renderMoment`, so a renderer bug moves both sides together; what this gate can catch is a
  bookkeeping error (a wrong unit, fire, carry set or body chosen from the log). (The eleventh audit replaced the old
  `surfaceShapesEverAppliedOf`-vs-run-counter comparison: those two counters increment under one
  predicate, so it could only fail if the surface object itself were swapped. The accessor still
  exists and the code still maintains it; it is no longer what gates.) Two surfaces with the same
  size and different bodies refuse (`sim-batch-surface-digest`), and the
  run also asserts the carry set equals that rebuild's shaped set minus the seqs the host removed
  by this fire (`sim-batch-carry-set-mismatch`). The PLAN lane runs the same gate (P10): every
  `--ignore-host-prunes` threshold plan checks the surface its depths read after EACH fire against
  `reconstructedSurfaceOf` (digest and CURRENT size, `surfaceSizeOf`; `surfaceShapesEverAppliedOf` is the
  separate cumulative count, P10), and the plan's second depth writer, the fresh
  surface in `renderPlanOf`, is checked the same way at the end of its series. The `[summary]` and `[pins]`
  lines PRINT the two arithmetic IDENTITIES as identities, never as a sum of overlapping terms:
  `eligible E = A appends + R replacements; appends A = P never-pruned + Q host-pruned originals`. `P` is a
  SUBSET of `A`, so the old `A (P + Q) + R` juxtaposition could read as an extra term; neither identity is a
  CHECK, and neither is compared by `assertSegmentPins` (P9/P12). Both print sites were corrected: the `[pins]`
  line kept the old `appends A (P + Q) + R` spelling after the `[summary]` line dropped it (eleventh audit).
- **The context is a stand-in, and every record says so.** Every send record and the run summary carries
  `contextStandIn`: `rolesUsed`/`roleOf` (a result is a `user` turn, a call an `assistant` turn), `droppedRowTypes`
  (this recording's types that reach no message, plus one entry per whole-row omission:
  `<type> (declared content, no text)` for a user/assistant/tool-result row `surfaceAt` skipped whole and
  `<type> (string content)` for a string body, P6; a projected row is listed as
  `<type> (tool-call parts, projected)`), `droppedRows` (the whole-row omissions' count and per-kind split),
  `projectedRows` (assistant turns whose only parts are tool calls: their calls are re-projected, so they are not
  lost), `droppedParts` (the prompt's dropped content parts, counted by
  kind, with `droppedPartsRule` saying what counts; a send record's block counts THIS prompt, while the SUMMARY's
  block is a copy of the FIRST fire's and says so with `promptScope: "first-fire"` — it is not a run total),
  `projectedParts` (the `tool-call` parts on a carried message, re-projected as `Tool call:` turns),
  `inventedPrefix`
  (`"<label>:\n"` before a result body), `toolCallProjection` (`Tool call: <name>\n<target>`), `placement` (shaped
  turns stay in place; the product rewinds the exchange), `systemSlot` (first `system/message` only;
  `developer/message` dropped) and `recallIdSource` (the sim mints `result:<seq>`, the host
  `dsh:<session>:result:<callId>`, so no sim marker id matches a host archive id). Every run carries the reason
  `stand-in-context`, which FOLDS the stand-in's own two facts (the invented label line and the dual-reading call
  projection): those are not separate citation reasons. Every run also carries `text-source` (P1): the body it
  reads is the transcript's decoded JSON text, and the product's is the SAME decoded text re-encoded at the
  adapter seam (`plugin.ts:1111`); the two readings differ on non-text and malformed content parts, never on a
  cut codepoint (see the restatement below). **`citable` is therefore
  ALWAYS false for a sim run**, whatever its arithmetic says. The dropped content is NOT folded into
  `stand-in-context` (P1): `dropped-parts:<n>` (the run's prompts' dropped parts, SUMMED: a part on a resent turn
  counts once per prompt that carried it, not once per unique part) and
  `dropped-rows:<n>` (the whole-row omissions) are their own reasons. Tool-call parts and tool-call-only
  assistant turns are NOT dropped content: the stand-in re-projects them (thirteenth audit item 7), and they are
  recorded as `projectedPartsTotal`/`projectedRows`, never in `dropped-content`. The summary also records
  `measurement.citableForStandIn`, the reasons MINUS ONLY `stand-in-context`; it RETAINS `text-source`,
  `dropped-parts` and `dropped-rows`, so the list is never empty and a prompt that lost an image/file part or a
  whole row cannot read clean. `contextStandIn.tools` states where the TOOL SCHEMA came from —
  `{ source: "request/header", seq, count }`, or `source: "none", seq: null, count: 0` for a recording with no
  header, and `count: 0` under a header that names none. Either empty case emits the reason `tools-absent`, so a
  prompt sent with no tool schema can never look like a run that had none to send (P2).
  `text-source`'s mechanism, restated (P8): both readings are of the same DECODED text. The adapter builds a
  result's bytes as `new TextEncoder().encode(textOf(message['content']))` (`plugin.ts:1111`), a re-encoding of
  text the host's JSON already carried decoded, so no partial UTF-8 tail can be dropped at that seam and a
  mid-codepoint cut is impossible in a `.v4.jsonl` recording. What the two readings really differ on is CONTENT
  PARTS: `textOf` joins the `type:"text"` parts and drops every other part that is not re-projected (image, file,
  malformed), so the product's line count and quotes can differ from this module's only where the body is not
  made of text parts alone.
- **The `jsonl-20` ` [N line(s)]` suffix is the product's, checked byte for byte.** `sim-batch-units.test.mjs`
  compares the sim's whole ask with core's `entryBatchAskMessage(..., "jsonl-20")` for both variants; `3option`
  carries no suffix.
- **The default grammar is the PRODUCTION default.** `--ask-grammar` defaults to `jsonl-20`, exactly
  `DEFAULT_ENTRY_ASK_GRAMMAR` in `packages/core/src/entry/batch-ask.ts` (owner ruling 2026-11-05), so a run that
  names no grammar measures the shape a default product run sends. `3option` and `two-option` remain selectable,
  but any grammar other than `jsonl-20` is named on the reason list as `non-default-grammar:<id>`; the sim-only
  arms still add `sim-only-arm`. `jsonl-20` decisions are read by CORE's `readJsonl20Answer`, not a sim copy: a
  shared-case parity test compares `answerRowsOf` to `parseEntryBatchAnswer` over every refusal code and action
  shape (twelfth audit item 1).
- **The no-keepall A/B lane.** `node dev/sim/sim-ab-grammar.mjs --i-am-the-owner <the live lane's flags> --out
  <dir>` runs the live lane twice over the same inputs: once with `jsonl-20` and once with
  `jsonl-20-nokeepall`, forwarding every other flag unchanged. Only `--ask-grammar` differs; each arm writes
  under `<dir>/<grammar>/`, and `<dir>/ab-grammar.json` reports both arms' decisions, freed/kept bytes,
  refusals, answer mix and ask bytes. `jsonl-20-nokeepall` offers `forgetall` and `keeplines` only (a `keepall`
  row is `action-not-in-grammar` and keeps), teaches a whole-range `keeplines` as the keep-everything shape,
  and drops the keep-some-whole share sentence from both the 70 percent and 40 percent variants.
  This two-verdict shape is the intended live setup, but the live path still needs product code: the
  bulk-prune template offers three verdicts and no config path selects `jsonl-20-nokeepall`, so the sim
  lane is today's only implementation. The sim lane is offline plumbing, not a product measurement.
- **Pins.** The default path keeps `SEGMENT_PINS`; the ignored path `IGNORED_SEGMENT_PINS` (same segment, same
  reasoning, its own counts and peak). Both pin blocks compare TWO input hashes, and the API-path binding is a
  binding of STATED hashes, never a requirement that every run states them (P12): a stated transcript hash must
  equal the hash `readTimeline` computed from the bytes it replayed (a row array has none, so a stated hash over one
  refuses `sim-batch-pins-rows-unpinned`), a stated usage hash must name a `usageFile` that is present and hash to
  it, and a segment-139 claim REQUIRES both (the usage half included) or refuses. `main` always passes both; a
  direct `runLane` caller that passes no `input` records the transcript hash the timeline could read and a `null`
  usage hash, and its run is not a pinned claim. The reasoning gate runs on every
  transcript: at the PINS it is a count plus a byte sum against the structural counts; at every PROMPT and at the
  transport boundary the ruler is the ordered `(turnSeq, sha256(reasoning_content))` PAIRS, so a substitution, a
  normalisation, a re-encoding or turn A's reasoning on turn B refuses (`sim-batch-reasoning-mismatch`,
  `sim-batch-reasoning-boundary`). Content parts with no resendable block refuse `sim-batch-reasoning-unresendable`;
  resendable turns with zero stream entries refuse `sim-batch-reasoning-stream-absent` (both ADR-0045 counts
  gate); mixed turns refuse `sim-batch-reasoning-unresendable-rows`. `sim-batch-reasoning-turns` (the resendable
  count equals the turns carrying a reasoning part) holds BY DEFINITION after the unresendable gate — both
  numbers are read off the same parts — so it is a restatement, not a gate. The gate that can fail on a
  symmetric loss is the COVERAGE floor: `reasoningTurns / assistantTurns` below `REASONING_TURN_COVERAGE_FLOOR`
  (0.55) refuses `sim-batch-reasoning-coverage` at any segment (the pinned world reads 86 / 139 = 0.6187). A turn whose
  PARTS were dropped whole leaves those two counts equal, so the scoped rows also record the assistant-turn
  population (`assistantTurns`), the turns with any part (`reasoningPartTurns`) and the turns whose own
  replay-state/stream echo names a reasoning block (`reasoningMarkedTurns`): an echo without a part refuses
  `sim-batch-reasoning-parts-lost` at any segment (P4). The live summary records
  `assistantTurns` / `partTurns` / `markedTurns` / `turnCoverage`, and `turnCoverage` is a GATE INPUT:
  `coverageFloor` rides beside it and the run refuses below it (`sim-batch-reasoning-coverage`). Zero declared
  reasoning refuses `sim-batch-reasoning-absent` unless `--allow-zero-reasoning` records a void comparison.
  A timeline that DECLARES reasoning must put at least one on the wire: if every send's `reasoningMessages` is 0,
  `runLane` refuses `sim-batch-reasoning-never-sent` (P3) and the summary records `reasoningSent: true` on a run
  that passed.
  `assertSegmentPins` runs in `runLane` and `main`. A test that claims the pinned world SKIPS when the input is
  absent (`requirePinnedWorld` in `sim-batch-live.test.mjs`, `sim-batch-report.test.mjs` and the pinned cases of
  `sim-batch-units.test.mjs`), and the skip message names BOTH missing paths and the
  `CREMATOR_SIM_EVIDENCE` variable. Why skip and not pass: a clean checkout cannot reproduce the pinned values from
  the repo (`scratchpad/` is disposable by law), and a skip is counted and printed, never a green test that did
  nothing. With the world present every pinned check runs normally; no pinned check is deleted or weakened. The
  named PAIR-2 spawns and pair-2 real-transcript cases SKIP for the same reason (a second fixture, not the pin).
  Every default-world CLI case in the pinned files carries the same guard, because `main` reads its input before
  some flag refusals. A pinned-world claim with an EMPTY depth series refuses
  (`sim-batch-pins-depth-absent`): the peak is a pin, and a claim without its ruler is not a claim. Every run
  records `build` (node, versions, the core dist and the sim modules' hashes), so the code that produced a number
  is named.
- **The sim test states the pruner too, in two readings.** `sim-batch-live.mjs` takes `--ignore-host-prunes`
  (off) or `--allow-host-pruner` (on, ADR-0041's opt-out); one is required, both or neither refuses by name, and
  every send record and the run summary name both readings:
  - `inputHostPruner` is the INPUT RECORDING's state, READ FROM THE RECORDING (`compaction/prune` rows present,
    whole file or in the segment) — never from the flag. A recording made with the pruner on reads `"on"` even
    when this replay models it off, and such a run carries the `host-pruner-on` citation reason, a reconstruction
    included (P1).
  - `modeledHostPruner` is the state this replay MODELS: `"off"` under `--ignore-host-prunes`, `"on"` under
    `--allow-host-pruner`.
  `runHostPruner: "none"` rides beside both: a replay mounts no host mechanism, so reusing ADR-0041's
  `hostPruner` word would claim a mechanism the run did not run. `--transport deepseek` refuses
  `--allow-host-pruner`.

The live launcher's own line (both offline launchers also accept `--ignore-host-prunes`):

```sh
node dev/sim/sim-batch-live.mjs --i-am-the-owner --transport stub --segment 139 --ignore-host-prunes --reconstruction --mode threshold --thresholds 60000 --ask-grammar jsonl-20 --token-grant 10000000 --out <dir>
```

**`--segment` is mandatory, enforced in code.** `readTimeline` refuses an absent segment by name
(`sim-batch-segment-required`) whenever the log carries a `compaction/start` row, and a segment that includes one
refuses `sim-batch-segment-compaction`: the replay never reaches native compaction.

**The default invocation carries no timer and no ceiling.** `--kill-ms` and `--ask-ceiling` both default to 0
(OFF), and `--token-grant` is REQUIRED (10,000,000 for a sim run; 100,000,000 for a live dsh run). The token
budget is the only run cap. A run that reaches it stops with `stoppedAtBudget` and its FIRST `[summary]` line
begins `[summary] TRUNCATED: stopped at the token budget N after M token(s); K unit(s) carried`. A positive
`--ask-ceiling` is still an optional stop: the line begins `[summary] TRUNCATED: stopped at the ask ceiling N
after M ask(s); K unit(s) carried`, and the reason list carries `stopped-at-ceiling`; a reader never has to reach
the reason list to learn the sample is short (P11). Leave the optional caps at 0 to run to the natural end.

**Completeness is its own field (P11).** `stoppedAtCeiling` says only that the ceiling stopped the lane; it is
never a completeness flag. The summary records `complete` (true only when
`stoppedAtCeiling === false && unansweredFires === 0 && carried === 0 && refusedSends === 0
&& refused === 0 && keptNoQuoteRows === 0 && droppedPartsTotal + droppedRowGaps.count === 0
&& segmentExcludedRows === 0 && systemDroppedRows === 0 && hostPrunedBeforeLanding === 0`) and
`incompleteReasons`, which names every way the run falls short — `stopped-at-ceiling`, `refused-sends`,
`unanswered-fires`, `batch-remainder:<n>`, `carried-units:<n>`, `refused-rows:<n>`,
`kept-no-quote:<n>`, `dropped-content:<n>`, `segment-cut:<n>`, `system-absent:1`,
`system-unreadable:1`, `host-pruned-before-landing:<n>`. P1 (eleventh audit) added
`refused-rows:<n>`: a tabled row the PARSER refused is an answer the run did not get, so ten rows tabled,
seven decided and three refused can no longer read `complete: true` over 70% of its own sample.
Twelfth audit item 5 added `kept-no-quote:<n>` and `dropped-content:<n>`: a kept row the quote re-read dropped,
and every part or whole row the stand-in itself lost, are content the run did not measure. Projected tool-call
parts are NOT in `dropped-content`: they are re-projected as `Tool call:` turns (thirteenth audit item 7).
Thirteenth audit item 2 added `system-absent:1` / `system-unreadable:1` (the prompt's first message is missing
or empty; `systemDroppedRows` is 1) and `host-pruned-before-landing:<n>` (an eligible unit the host removed
STRICTLY before its own landing step, so no fire could table it; a prune on the landing step itself still lets
that step's fire table the row).
Twelfth audit item 11 added `batch-remainder:<n>`: the product's `batchVerdict` NEVER FLUSHES a partial batch
(`batch-trigger.ts`), so a lane that does not divide its population always leaves a tail. That tail is the
product's own shape, not a lost row; the incompleteness list names it separately from `carried-units:<n>`, which
keeps only the OTHER unasked units (a host prune that beat every fire). A population that divides exactly has no
remainder and can complete. The old `truncated` field was set from the ceiling alone, so a failed send or a cut segment
read as a complete sample; it is gone. The `[summary]` line prints `INCOMPLETE: <reasons>` when a run is short
for any reason other than the ceiling. `triggers` counts the fires that REACHED an ask (a ceiling stop is not a
trigger), and `asks` equals it on every summary the runner writes.

**ADR-0041 Decision 6's zero-prune gate.** `assertZeroPruneGate` runs in every launcher and in `runLane`. A replay
cannot count the replayed world (`--ignore-host-prunes` deletes every `compaction/prune` row before the world is
built, so that count is structurally zero); the branch that CAN fail is the source count `pruneGate.replayedPrunes`,
taken BEFORE the filter. A non-zero count refuses `sim-batch-zero-prune-gate` unless `--reconstruction` declares the
run; `inputPruneEvents` is the whole recording's count, and `fab6632e@139 --ignore-host-prunes --reconstruction`
lands at status `reconstruction`.

**Citable is a reason list; a sim run is never citable.** `runLane` computes `measurement.reasons` and sets
`citable = reasons.length === 0`. Because `stand-in-context` and `text-source` are unconditional, `citable` is
ALWAYS false for this sim. The stand-in's own two facts are FOLDED into `stand-in-context` (they are not separate
`input-deviation` reasons), but its CONTENT LOSSES are not: `dropped-parts:<n>` and `dropped-rows:<n>` are their
own reasons (P1). `measurement.citableForStandIn` subtracts ONLY `stand-in-context`; it RETAINS `text-source`
and the two dropped-content reasons, so it is NEVER empty and never hides a lost part or row — it is not a
citation, only the same list with the wire's stand-in statement removed (P10). Every emitted reason is
validated against `CITABLE_REASONS` at the end of `runLane` (P9): an unknown reason refuses
(`sim-batch-reason-unknown`) instead of reaching a summary, and the SUFFIX is validated too (P6) — a counted
reason takes a non-negative integer and a word-suffixed reason only its declared spelling, so
`sim-only-trigger:bogus`, `batch-lane:anything` and `carried-units:-3` refuse. The summary records every input
the reasons read (`transport`, `live`, `inputHostPruner`, `modeledHostPruner`, `runHostPruner`, `reconstruction`,
`grammar`, `askOrder`, `mode`, `thresholdUnits`, `askScope`, `firstFireDepth`, `eligibility.floor`,
`fidelitySynthetic`, `asks`, `triggers`, `refusedSends`, `refused`, `depthOverflow`, `carried`, `reasoningSent`,
`inputDeviations`, `productBatchSize`, `segmentExcludedRows`, `keptNoQuoteRows`, `droppedPartsTotal`,
`droppedRows`, `contextStandIn.tools` and `usageSteps.statedOnlySteps`), so each is re-derivable. Several of the
fields `citableReasonsOf` reads are CONSTANTS for a run rather than per-run readings: `productBatchSize` is
`DEFAULT_CONFIG.entryAskBatchSize`, `floor` is `FLOOR_BYTES` unless `--floor` is passed, and `grammar`, `askOrder`,
`mode`, `thresholdUnits` and `askScope` take their declared defaults; `stand-in-context` and `text-source` are
unconditional. Recording them proves the lane's stated configuration — a reason fires only when a value differs
from its default (or a structural fact is true) — not that each one varied. `eligibility.excluded.errorResult` is
recorded as a population split, never as a reason (P9).

| reason | meaning |
| --- | --- |
| `stopped-at-ceiling` | the lane stopped at a POSITIVE `--ask-ceiling` before all its triggers; `--ask-ceiling 0` is OFF, so it emits no such reason. The sample is truncated, and the FIRST `[summary]` line prints `TRUNCATED` |
| `stopped-at-budget` | the lane's token spend reached `--token-grant`, the run's only cap; the sample is truncated, and the FIRST `[summary]` line prints `TRUNCATED` |
| `zero-reasoning-void-comparison` | the input declares zero reasoning and `--allow-zero-reasoning` recorded a void comparison (ADR-0045) |
| `host-pruner-on` | the INPUT RECORDING was made with the host's tool-result pruner on (read from its `compaction/prune` rows, never from the flag); a host-vs-product comparison, never a product-alone measurement (ADR-0041). A `--ignore-host-prunes --reconstruction` replay of such a recording still carries it (P1). The run states `modeledHostPruner` and `runHostPruner: "none"` beside it |
| `reconstruction` | the run DECLARED `--reconstruction`: a pruner-off replay of a recording that carries prune events, a rebuild, not a product measurement (`pruneGate.status` says whether this input needed it). `--reconstruction` with `--allow-host-pruner` REFUSES by name (`sim-batch-reconstruction-host-pruner`): the two state opposite worlds, so no summary can claim a reconstruction beside a modeled host pruner |
| `stub-transport` | the transport is not a live provider; no provider answered |
| `stand-in-context` | ALWAYS present: the prompt is the chat stand-in `contextStandIn` describes, never the host's wire, so `citable` is always false. `citableForStandIn` drops ONLY this reason |
| `dropped-parts:<n>` | the run's prompts dropped `n` non-text content parts, SUMMED over prompts (a part on a resent turn counts once per prompt that carried it, not once per unique part). The count covers image, file or another kind `textOf` does not read; a `tool-call` part is re-projected as a `Tool call:` turn and is counted under `projectedParts` instead (thirteenth audit item 7) |
| `dropped-rows:<n>` | `n` user/assistant/tool-result rows that declare content reached no message: a row `surfaceAt` skipped whole (declared parts, no text, no reasoning) or a string-content body (P6). A tool-call-only assistant turn is a PROJECTED row (`projectedRows`), never a lost one; an image-only tool result is a gap under its own name (thirteenth audit items 3 and 7) |
| `system-absent` | the scoped recording carries no `system/message` row, so the prompt's FIRST message is an empty slot. The timeline records `systemAbsent`, the summary `systemDroppedRows: 1`, and `contextStandIn.droppedRowTypes` names `system/message (absent)`. This is a named dropped turn, never a silent empty string (twelfth audit item 4) |
| `system-unreadable` | the first `system/message` row is present but `textOf` reads no text from it (a string content body, or parts with no string `text`). Recorded as `systemUnreadable`, with `systemDroppedRows: 1` and a `system/message (unreadable content)` entry in `droppedRowTypes` |
| `text-source` | ALWAYS present (P1, restated by the eleventh audit's P8): the body is the transcript's decoded JSON text (`textOf`), and the product's is the SAME decoded text re-encoded at `plugin.ts:1111`; the substitution is that this module drops every non-text part that is not re-projected as a `Tool call:` turn (image, file) and every malformed content part, so line counts, quotes and eligibility can differ where a body is not text parts alone. `citableForStandIn` RETAINS this reason |
| `tools-absent` | the run's prompts carry no tool schema: the recording has no `request/header` (`contextStandIn.tools.source` is `"none"`) or the header names no tools (P2). Not a refusal — the prompt is still built — but the run may not read as if it had a schema |
| `usage-shape-unverified:<n>` | `n` depth reading(s) whose cache shape rests on the row's own `inputTokensIncludeCache` statement alone, with no prompt count and no total to corroborate it (P5); `usageSteps.statedOnlySteps` names the steps |
| `synthetic-ruler` | a transport DECLARED live whose fidelity bands were graded by the sim's own estimate (`fidelitySynthetic > 0`); no provider graded that run |
| `sim-only-arm` | the run used a sim-only grammar (`forgetlines`, `keeplines-60`) or an instruction order other than `first`; `two-option` SHIPS and is not a sim-only arm (`config.ts` accepts it, `entry-ask.ts` reads it) |
| `non-default-grammar:<id>` | the run named a SHIPPED grammar other than the product default `jsonl-20` (`3option`, `two-option`). Reaching for a selectable arm is a different sample from a default run, so it is named; the sim-only arms carry this reason beside `sim-only-arm` |
| `sim-only-trigger:depth-tokens` | a threshold lane counted current DEPTH; the product's trigger takes `count` and `landed-bytes` only (`plugin.ts` `entryTriggerFor`), so this cadence is the sim's own |
| `sim-only-ask-scope:kept` | `--ask-scope kept` re-tables rows the product settles after one answer (`entry.entryJudged`); the re-ask is the sim's own sample. The quote re-read is MODELED, not a reason: a kept row whose shaped body can no longer show two quotes is dropped from the table (`keptNoQuoteRows`/`keptNoQuoteUnitIds`, P4) |
| `first-fire-depth` | `--first-fire-depth` held the first fire for an absolute depth the product does not gate |
| `batch-lane:<n>` | the batch lane's size `n` is not the product's configured `entryAskBatchSize` (1); the sim's `DEFAULT_LANES` is 8, so its default batch lane measures a cadence the product does not ship (P2). The summary records `productBatchSize` |
| `segment-cut:<n>` | `--segment <lastStep>` dropped `n > 0` later rows before any unit was built; the run's population is the cut's, never the recording's, so it cannot report that every row was asked (P3). A cut that removed ZERO rows emits no `segment-cut` reason (thirteenth audit item 8). `segmentExcludedRows` rides the summary |
| `non-default-floor:<n>` | the run used a floor other than the product's 512 B answer; the sample differs from the product's |
| `no-ask` | the lane asked nothing; the run refuses `sim-batch-no-ask` before a summary is written |
| `refused-sends` | at least one send failed, timed out or was refused; the answers are incomplete |
| `no-answered-rows` | no tabled row was answered because EVERY send failed; a run whose rows were tabled and all REFUSED refuses by name (`sim-batch-no-decided-row`) before a summary, so it never carries this reason |
| `refused-rows:<n>` | `n` tabled ANSWER rows were refused by the parser (a row-level refusal, not a failed send); each is an answer the run did not get. It is an INCOMPLETENESS reason too (P1, eleventh audit): the aggregates cover `n` fewer rows than the run tabled |
| `depth-overflow` | the policy out-freed the measured depth and the series was clamped at zero; the clamp is recorded, never silent |
| `carried-units:<n>` | `n` askable units were never asked for a reason OTHER than the product's own partial-batch tail (the ceiling's unsent batch, a stopped fire's table, and `prunedBeforeAsk` units the host removed before any fire tabled them); an incomplete sample is a reason. A batch lane's natural short final batch is named `batch-remainder:<n>` in the INCOMPLETENESS list instead (the citation reason still counts it in `carried`) |
| `reasoning-never-sent` | the timeline declares reasoning and no send carried one; `runLane` REFUSES this run by name (`sim-batch-reasoning-never-sent`) before a summary, so the reason is reachable only from a caller that builds its own list (P3) |
| `input-deviation:<id>` | one DETECTED deviation of this input (see `inputDeviations`), one reason per deviation: `agent-instructions-splice`, `system-model-name`. The stand-in's own two facts are folded into `stand-in-context` |

`asks` counts a fire THAT WAS ATTEMPTED, whether or not the transport answered: a failed send is an ask plus one
`unansweredFires`, its batch is dropped and counted in `carried`. `assertAskTotals` runs after EVERY fire, not only
before the summary. Its `asks !== triggers` branch CANNOT fire today (both counters move in `fireOf`, and a failed
send counts as an ask), so it is a guard against future drift, never a reachable class; the old `asks < triggers`
reason is gone. It also refuses a run that asked nothing (`sim-batch-no-ask`). Both stop paths add the batch they
did not send: the batch ceiling adds the trigger's own unsent batch (`state.pending.length + verdict.batch.length
+ the tail`, short by `--lanes` before the fix), the threshold ceiling's `pending` already holds its table. The
FAILURE paths are now complete (P5): the batch path adds its dropped batch AND `prunedBeforeAsk`; the threshold
path builds a SET of the unasked ids (`pending`, the tail, the failed table minus rows an earlier fire already
asked) so a re-asked `kept` row is never counted as never asked, and adds `prunedBeforeAsk`. Every stop path adds
`prunedBeforeAsk`.

**Freed bytes come from the body the FIRE applied (P2).** `bytesFreedByPolicy` and `bytesFreedGross` are read
from `reconstructedRemovalsOf`, which follows every decision through the body the rebuilt surface held at that
point — the landed text for a first ask, the SHAPED body for a `--ask-scope kept` re-ask. A final re-render of
the last decision over the landed text reported bytes no fire freed (a re-ask sized against the shaped body was
re-sized against the original). The fire loop books one removal per unit whose removal CHANGED, and a NAMED
assertion at the end of `runLane` refuses `sim-batch-booking-sum` unless the bookings' sum equals
`bytesFreedByPolicy`. A shape the host's own prune removes at or before the step it lands on frees no window, so
it is neither booked nor counted. Only the THRESHOLD plan lane returns `removalBookings` (on the same rule, so a
plan-vs-live comparison exists); `planLane` returns none — the batch plan books nothing to compare, and the
equality test runs on the threshold lane.

**A kept row is re-checked for its two quotes (P4).** The product re-runs `factsShowTwoQuotes` over the live
node before it tables a row (`plugin.ts` `entry-ask-off`, reason `no-quotes`). The sim does the same over the
SHAPED body it is about to table: a kept row that can no longer show two quotes leaves the table, its earlier
removal stands, and the send record names it (`keptNoQuoteUnitIds`, `keptNoQuoteDrops`); the summary counts them
under `keptNoQuoteRows`. This is modeled product behaviour, not a citation reason. The row count the ask carries
is `tabledRows`, distinct from `batchSize`.

**Standing lane (a deterministic STUB regression pin, not a measurement).** The transport is `--transport
stub`, and the stub answers by a FIXED RULE over the recording's bodies: in each ask, position 0 and every 4th
position after it gets `keepall`, every other row gets `forgetall` with `stub forgotten result <id>`. No model is
called; the same recording produces the same answers and the same numbers every time. These figures are that
rule's output over `fab6632e@139`, pinned by the standing-lane test as a regression value for the stub path:
`node dev/sim/sim-batch-live.mjs --i-am-the-owner --transport stub --segment 139
--ignore-host-prunes --reconstruction --mode threshold --thresholds 60000 --ask-grammar jsonl-20 --token-grant 10000000`
on 2026-11-06 (`fab6632e@139`): **8 fires** at steps 16, 22, 31, 47, 60, 84, 115, 129; reconstructed depth at each
trigger is **estimated** at 3.04 B/token: 71,826 / 97,164 / 108,082 / 127,664 / 151,547 / 177,542 / 213,573 /
244,025 tokens, never a provider count. The peak prompt is 755,326 B content-only and 789,277 B as the request
body, so `ceil(789,277/3) = 263,093` guard tokens and **248,463** estimated. 201 eligible units, all askable;
`hostPrunedEligible` 0, `askableBeforePrune` 0, `hostPrunedBeforeLanding` 0, `prunedBeforeAsk` 0 (this lane
replays a world with no host prunes, so the time-aware stream and the static one agree here);
**967,042 B freed NET** (986,437 gross); 24 carried. All eight stub sends are `usage.ruler: "synthetic"`:
`fidelitySynthetic` 8, `fidelityWarnings` 0 — that zero says no PROVIDER band was graded, never that an estimate
agreed. **Every figure here is pinned by the standing-lane test as a stub regression value**, and a missing input
now SKIPS that test with both missing paths named, so a clean checkout shows a skip, never a pass by doing
nothing and never a red suite for absent evidence. At lane 8 BOTH arms' PLANNED PEAK crosses the 400k guard (the
eleventh audit: `promptPeakOf` reports the peak instead of refusing at the first over-guard fire, so these are true
peaks, not the first crossing; the twelfth audit moved the DEFAULT grammar to `jsonl-20`, so these are the default
run's bytes): pruner-off 1,734,566 content B (598,013 guard) and 1,794,037 wire B; pruner-on 1,477,231
content B (508,266 guard) and 1,524,798 wire B. A SEND at either peak refuses `sim-batch-prompt-overflow` before
any socket.

**What the standing lane IS.** It is a deterministic, rule-driven STUB replay over the recording's bodies on a
chat STAND-IN: no model is called, so nothing here is model behaviour. It also has a cadence the product does not
have: `--mode threshold --threshold-units` defaults to `depth-tokens`, a depth trigger the
product's `entryTriggerFor` does not implement (it takes `count` and `landed-bytes`). The `landed-bytes` arm
CALLS core's `landedBytesVerdict` (`packages/core/src/entry/landed-bytes-trigger.ts`); the sim keeps no copy of
the rule (P6), and a shared-case test compares the two. It also runs on the product's LANDING cadence: the
trigger is evaluated after EVERY landing, so a unit that lands on step S can fire on step S, exactly as
`entryTriggerFor` runs from the landing call (twelfth audit item 3). Its plan and live lanes share that schedule,
and the segment-146 bytes-240k pins are the corrected per-landing numbers. It is never a product
measurement and never a model measurement — the answer is the stub's fixed rule — and its reason list says so
(`stub-transport` and `sim-only-trigger:depth-tokens` are two of its reasons). The run is
**non-citable**; its full reason list is:
`["host-pruner-on", "reconstruction", "stub-transport", "stand-in-context", "text-source",
"sim-only-trigger:depth-tokens", "segment-cut:1484", "carried-units:24",
"input-deviation:agent-instructions-splice", "input-deviation:system-model-name"]`, and
`citableForStandIn` is the same list with only `stand-in-context` removed (so it retains `host-pruner-on`,
`text-source` and the segment cut). The recording's tool-call parts are re-projected as `Tool call:` turns, so
they are counted under `projectedPartsTotal`/`projectedRows`, never as dropped content (thirteenth audit item 7).
The lane's `inputHostPruner` is `"on"` — the recording it
replays was made with the host pruner on (132 prune rows in the file, 67 in the segment) — and its
`modeledHostPruner` is `"off"`: the replay is a reconstruction, which is why `host-pruner-on` sits beside
`reconstruction` (P1). Its summary also records
`reasoningSent: true` (P3) and the reasoning coverage readings (`assistantTurns`, `partTurns`, `markedTurns`,
`turnCoverage` with `coverageFloor`) beside the ADR-0045 counts; `assertReasoningCarried` refuses both a
part/echo loss and a coverage below the floor, and it refuses
`sim-batch-reasoning-parts-lost` if any assistant turn's own replay-state or stream echo names a reasoning block
while its content part is gone (P4).

**Known input deviations, recorded on every send and every summary.** Two are DETECTED from the recording; each
is a citation reason (`input-deviation:<id>`) and each rides `inputDeviations` on every send record and the run
summary. A lane whose input does not carry them does not claim them. The stand-in's own two properties (the
invented `"<label>:\n"` line and the dual-reading call projection) are recorded in `contextStandIn` and FOLDED
into the universal `stand-in-context` reason, never counted as separate deviations.

| id | what the run records |
| --- | --- |
| `agent-instructions-splice` | the recording has an extra `Additional instructions from:` user turn inside the pinned cut (8,323 B at step 128 in `fab6632e@139`), so the surface carries one assistant-instruction block the restored host would not have; the record states its step, seq and byte count |
| `system-model-name` | the recorded system prompt names `deepseek-v4.1-flash-1017` while the sim route is `deepseek-flash`; the record states both names |

The world was also recorded with the host pruner on — the replay's `--ignore-host-prunes` models the off state on
top of a log that already produced those 132 journals, so `inputHostPruner` reads `"on"` from the log while
`modeledHostPruner` reads `"off"`, and the run carries `host-pruner-on`; the pins, the `reconstruction` gate
status and the contaminated host series make the mix visible rather than hiding it. The two-path comparison run is disposable
evidence under `scratchpad/sim-retest-2026-10-30/lanes/`, never cited as committed proof.

## replay-depth-table.mjs — 15 dsh ask moments under the corrected table prompt (ISSUE-510)

`replay-depth-table.mjs` replays 15 `prune-threshold` → `prune-plan` moments from the three final-shape
runs under `scratchpad/launch/2026-11-18-leak-safe-110/` (`racoons-n1-correct`, `racoons-n2-correct`,
`racoons-n3-correct-3`). The line numbers are 1-based lines of each run's
`evidence/racoons/cremator-events.jsonl`.

**Offline (default, no socket, no key).** It folds `session.v4.jsonl` (`surfaceOp` appends, in-place
`replace`, compaction `shadowedSeqs` dropped only at their checkpoint), rebuilds the seed wire and checks
`prune-seed.seedHash` and its message/tool/dropped counts, rebuilds the plan with `UnitTracker` (512 B) +
`planPrunePass` and checks `units`, `askRows`, `tables`, `askTableTokens`, and reads the recorded baseline
(round `prune-verdict` count from the journal; removed bytes from the ledger's archive spans, opened
read-only with `node:sqlite`). Every moment prints the old bulk ask and the corrected
`entryBatchAskMessage(rows, "jsonl-20-nokeepall", firstTrigger)` size/sha256 and every gate's PASS/FAIL.
A failed gate refuses the send lane before any key is read. Exit 0 only when every gate of every moment
passes.

**Failed recorded baselines.** Three of the 15 recorded rounds are failed recordings, not real zeros:
`racoons-n1-correct` r23, `racoons-n2-correct` r12 and `racoons-n3-correct-3` r17. Every table attempt
refused every row `answer-unreadable`, every `l2RemovalCount` is zero, no `prune-verdict` was written and
the apply was skipped `no-removals`. `classifyRecordedBaseline` reads those signals; the moment keeps its
raw 0/0 for display, is marked `recordedFailed: true` / `recordedComparable: false` with a reason, and
gets no delta. The `recorded-baseline` gate prints `FAILED RECORDING (...)` on every such moment, so a
real zero (table answered, every row kept) and a failed recording are labelled differently and a failed
baseline can never pass as a comparable zero.

**Two aggregates.** Both are printed. `ALL-n` sums every moment, failed baselines included at their raw
zeros. `COMPARABLE-n` drops them, prints the moment count, and names them in
`excludedFailingBaselines=[...]`. Offline, the "new" side is the corrected table's units and bytes AT
STAKE. `--live <file[,file]>` folds recorded send-lane evidence into a display-only `[live-aggregate]`
pair of the same two lines (no socket, no key, no gate); it is how the recorded live results are reported
beside the offline baseline.

```sh
node dev/sim/replay-depth-table.mjs
node dev/sim/replay-depth-table.mjs --live <live-evidence-1.json>,<live-evidence-2.json>
node --test dev/sim/replay-depth-table.test.mjs
```

**Send lane.** `--transport deepseek --i-am-the-owner --token-grant <n> --kill-ms <n>` sends ONE request
per moment (seed messages + the run's 18 tools + the corrected ask); a refused row is a recorded result,
never re-asked. `--transport stub` answers from a fixed rule so the path is testable with no socket. The
kill timer arms before any input is read; the key comes from the `refs:` block of
`~/.dsh/.credentials.yaml` (`C:\Users\TZhen\.dsh\` or `C:\Users\TZ\.dsh\`) in-process, never printed or
exported. Evidence goes under `scratchpad/launch/<yyyy-mm-dd>-replay-depth-table/`, never committed.
`--only <run>:<round>` limits a run to named moments. The per-moment line prints every verdict
(`forgetall`, `keeplines`, `keepall`, `forgetlines`) so `decided` reconciles; an accepted `keepall` is
always the reader's normalization of a whole-range `keeplines` (the grammar refuses a literal `keepall`),
marked `wholeKeeps` / `keepallSource=normalized-keeplines`.

## replay-opencode-asks.mjs — 10 opencode ask moments under the corrected table prompt (ISSUE-510)

`replay-opencode-asks.mjs` replays ten `ask` moments from the two opencode final-shape lanes
`run-1` and `run-3` under `scratchpad/launch/2026-11-19-opencode-v2/` (ledger rows 32 and 34). Each
moment names a 1-based `journal.jsonl` line and the 1-based `capture.jsonl` generate request that
carried the ask. All ten used the two-option keepall/forgetall prompt (ISSUE-509), so the corrected ask
is a prompt change.

**Offline (default, no socket, no key).** Per moment it proves the captured last message hashes to the
journal's `promptSha256` and is `promptChars` characters, the prompt is the two-option one, the table's
row count and indices equal the journal, and every `forgetall` row resolves through an `ask-apply` record
to exactly one `recall_parts` row whose blob size equals `source_byte_length` (opened read-only with
`node:sqlite`).

**`L` comes from the unit, and the row is matched to it by identity.** Each row's line count is computed
from the captured unit's decoded result text — the fixed product's `unitBytes` geometry
(`packages/adapters/opencode/src/snapshot.ts`, line ranges over the decoded text). The recorded
pre-ISSUE-511 prompts carry the `{input,name,result}` envelope, so every old anchor says `line 1 of 1`;
that anchor is kept only as the row's quote. The row-to-unit match is NOT a walk over captured order: the
journal's `unitIds[i]` names the unit of the row at position `i`, and that unit's ledger archive is its
envelope, whose decoded result text (`envelopeResultText`, mirroring `opencodeUnitText`) is the identity
key. A row whose unit was never archived is matched by its anchor quote, which must name exactly one body.
The row's `callOrdinal` must agree too: within one call the table's ordinals strictly increase, and a
quote that names an earlier occurrence than the ordinal claims is a contradiction. Three outcomes stop the
moment and name the row: no unit, an anchor that fits two different bodies, and an ordinal that disagrees
with the anchor. Every row's quote is also verified against the matched unit, and `line-counts-from-unit`
re-reads each unit by its CALL ID (not the matched index) and re-derives both its `L` and its anchors.
Result: **474/474 rows matched (462 by the archived unit, 12 by a unique anchor), 368 multi-line** (16 /
50 / 51 / 46 / 21 / 48 / 42 / 0 / 45 / 49), and a partial `keeplines` inside `1..L` is accepted and
priced. The pre-fix order walk gave three rows the wrong unit — seg11 rows 327 (`[1 line]`, really
**86**), 328 (`[86 lines]`, really **27**) and seg2 row 148 (`[1 line]`, really **15**, 704 B) — and one
of them answered `keeplines [[1,1]]` on what it believed was a one-line unit.

**The corrected row quotes its own unit.** The recorded anchor is an envelope tail, so leaving it in place
put `line 1 of 1` beside `[86 lines]`. Each matched row's `anchorLines` is replaced by the product's own
`buildPruneAnchors` output over the unit's decoded text (the 30 and 70 percent byte shares), so the quote
is a real content line and agrees with `[L line(s)]`. `oldAnchorLines` keeps the recorded quote for the
identity proof. Corrected asks total **147,688 B**.

**Both byte spaces are stated.** `oldBytes` is the recorded baseline: the ledger's archived ENVELOPE sizes
(`recall_parts.source_byte_length`). `wholeUnitBytesDecoded` is the same removed units in decoded-text
bytes (787,971 B all-10). Every row `L`, every `keeplines` range and every partial's pricing are decoded
text; a delta across the two spaces is named, never mixed. `accountedOk` is printed as an IDENTITY
(`whole + partial + kept`, accumulated from the same bases), and `pricedOk` is the real cross-check: every
row must re-close on its own basis (`basis = freed + kept`), the summed bases must equal `knownBytes`, and
a removal with no basis is listed in `unpricedRows`. `partialLineOk` is false when a partial keep with
known text frees 0 B; `partialZeroRows` names those rows.

**A moment where every row was refused is a failedReading.** The send succeeded, but nothing was decided,
so its `newUnits`/`newBytes`/deltas are null and the record is `failedReading` with `allRefused`. It is
excluded from every scored sum, named in `allRefusedMoments` and in the per-moment line (`ALL-REFUSED`),
and makes the aggregate `successOnly`. The 2026-11-23 stored seg9 is exactly this case.

**A keep is sized from the same decoded text.** The ledger holds an archive row only for a unit the run
removed; a unit it kept has none. Such a row is sized from its captured decoded result text (same
`unitBytes` geometry) instead of being priced at 0 B, so `unknownUnits` is 0 and `accountedBytes ==
knownBytes` is a real check. `run-3/opencode-seg8-t`'s ten one-line `[write] swe-results/*.md` rows now
carry their real bytes (684 B total) rather than 0.

**Pre-send grant bound.** Before a `deepseek` send the lane checks
`spent + ceil(JSON.stringify(body).length / 3.04) > --token-grant` and stops with the
coverage-limited budget flag rather than overrunning the grant by a whole prompt (the 2026-11-23 live
draw ended 113,581 tokens over 3,000,000). Actual usage is charged after the send as before.

Old removals come from the journal's parsed verdicts and `source_byte_length`; the corrected
`entryBatchAskMessage(rows, "jsonl-20-nokeepall", firstTrigger)` size/sha256 is printed per moment with
70 percent on round 1 and 40 percent later (147,688 B total), and old/new/delta units and bytes are
reported per moment and in aggregate. The `delta-identity` gate is an identity, not a predictive check:
this lane replays the RECORDED answers under the corrected grammar, so the delta is zero by construction;
only a fresh draw predicts anything.

**A partial keep is priced.** In the send lane a `keeplines` that keeps a strict subset of a row's
lines frees the dropped lines, and the bytes are booked, not skipped: a dropped line frees its own
decoded text plus the newline that ended it (the product's range convention, ADR-0044 amendment;
`packages/core/src/util/lines.ts`). `partialKeepFreedBytes` computes the kept spans with
`byteRangeForLines` over the captured decoded text and subtracts them from that text's length. The
row is booked in the captured-text byte space even when the ledger still holds an older envelope
archive of it, because the answer's line ranges address the decoded text. Then:

- `partialLineBytesFreed` is the sum of dropped-line bytes across partial `keeplines`;
- `keptBytes` carries only the kept span for such a row, so `whole + partial + kept == knownBytes`
  stays a real identity;
- `newUnits` is `forgetall + keeplines + forgetlines` (a partial keep removes lines, so it is a
  removal unit, the dsh sibling's count) and `newBytes` is `whole + partial`;
- `partialLineOk` is true when every answered partial was priced and none freed 0 B; it is true with a
  reason only when no partial was answered (a one-line table, or every `keeplines` was a whole-range keep
  or a refusal), and false when a partial had no captured text to price or freed nothing while its text
  was known (`partialZeroRows`).
- `wholeKeeps` / `normalizedWholeKeeps` / `keepallSource` state that an accepted whole keep came from a
  whole-range `keeplines` the shipped reader normalized (`normalized-keeplines`), not from a model
  answering the `keepall` this grammar does not offer. A reporting marker only.

**`--live <file[,file]>` recompute (display only).** It reads stored send-lane evidence, rebuilds the
rows and units from the same journals and captures the default lane proofs, re-reads each record's
stored `firstContent` through the shipped reader, prices the partial keeps, and prints the corrected
aggregate — with no socket, no key and no send. It refuses a record whose stored `firstContent` no
longer hashes to its recorded sha256 (truncated or edited). The stored evidence file is never
modified; the corrected report is written beside it as `<name>-recomputed.json`. On the
2026-11-23 rerun it reports nine scored moments (seg9 is a failedReading): 307 u / 835,513 B
(679,440 B decoded) to 380 u / 973,748 B (whole 885,089 B + partial 88,659 B, 23 rows, kept 90,498 B,
`accountedOk`, `pricedOk`), delta +73 u / +138,235 B.

```sh
node dev/sim/replay-opencode-asks.mjs
node dev/sim/replay-opencode-asks.mjs --live scratchpad/launch/<dir>/replay-opencode-asks-deepseek.json
node --test dev/sim/replay-opencode-asks.test.mjs
```

**Send lane.** `--transport deepseek --i-am-the-owner --token-grant <n> --kill-ms <n>` sends ONE request
per moment: the captured `model`/`tools`, the captured messages minus the old ask, then the corrected
ask. A refusal is a recorded result, never re-asked; a failed send exits 1 and books null deltas. The
kill timer arms before the first read; the key comes only from the `refs:` block of
`~/.dsh/.credentials.yaml` (`C:\Users\TZhen\.dsh\` or `C:\Users\TZ\.dsh\`) in-process, never printed or
exported. `--transport stub` answers from a fixed rule with no socket and labels its evidence
`laneKind: "stub"`, `synthetic: true` (not a draw, not a counterfactual). Records are written after every
moment, plus once before the first send. Evidence goes under
`scratchpad/launch/<yyyy-mm-dd>-replay-opencode-asks/`, never committed. Nested `audit-*/` directories
under that evidence dir (`audit-6b/`, `audit-6c/`, `audit-6d/`) are superseded outputs from earlier runs
of this script, not current lane evidence. A stub-only `--stub-fail length-trip|transport-error` seam
exercises both failure charge branches without a socket: a billed truncated draw is charged and a
failure that states no usage charges 0, and either makes the aggregate `successOnly` and exits 1.
