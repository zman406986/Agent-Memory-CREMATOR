/**
 * The model-facing copy of the core, as constants: the marker, receipt and
 * inventory strings, the entry ask's blocks, plus the shipped prompts.
 *
 * Pure data, no imports. `assets.ts` re-exports every name here, so callers keep
 * importing from `rules/assets.js`; the split exists only to keep each file
 * under the line cap.
 */

// The entry checkpoint's marker (ISSUE-056 chunk C2; design §1 "Marker text"
// and ADR-0022 §5). It states the kept line ranges, the result's total line
// count, how many bytes were dropped and the recall id — nothing else, and
// none of the vocabulary the deleted size rule used. The empty form is the
// `forgetall` floor line: no lines were kept, so no byte segment ships. These
// two are the only marker shapes; the entry renderer fills their slots.
//
// The templates END IN A NEWLINE (ISSUE-063, live R-3 defect). A marker is a
// whole line, so its terminator is part of the marker and not the renderer's
// private business: a marker spliced before a kept range without it put the
// recall id's last characters on the next kept line's text (`…sha256:7391633c…
// d2bC:\Users\…`), which made the id unparseable in 9 of 10 live shaped turns.
// Keeping the terminator here is also what makes the converter's independent
// parser — built from these very constants — measure the same `markerBytes`
// the renderer emits, so `landed = kept + gaps·markerBytes + summaryBytes +
// framing` still closes with `framing = 0`.
export const SHAPE_MARKER_TEMPLATE =
  "[racoons] kept lines <ranges> of <N> · <B> bytes dropped · necromancy <id>\n";
export const SHAPE_MARKER_EMPTY_TEMPLATE =
  "[racoons] kept 0 of <N> lines · necromancy <id>\n";
// The cap marker left with the cap rule (ADR-0014 deleted it 2026-10-23; the
// entry checkpoint speaks through the two templates above). Its literal is gone
// from the inventory on purpose: the vocabulary test bans "cap" from shipped
// copy, and an unused member cannot be kept "just in case" without it.
const NEGATIVE_FACT_TEMPLATE =
  "[search: <target>] not found in: <path> · <title or first heading> · <lines> · <size>, …";
export const NONE_MATCHED =
  "No match in these files for this target. Do not re-read them.";
const EMPTY_NEGATIVE_FACT_TEMPLATE = `[search: <target>] ${NONE_MATCHED}`;
const SPAN_MARKER_TEMPLATE =
  "[Showing lines X–Y of N in <path>. Full content restorable via necromancy id.]";
// Receipts, one shape per forgetting verdict kind (ISSUE-017 §3). A `forgetall`
// receipt carries the answer's descriptor in the label slot; a `keeplines`
// receipt names the line ranges the answer gave up and carries no descriptor,
// so it ships the floor shape. Which template applies follows from whether a
// label exists, never from the caller claiming a verdict kind.
const RECEIPT_TEMPLATE =
  "[not retained] <path> <ranges> — about: <label> · necromancy <id>";
const RECEIPT_FLOOR_TEMPLATE =
  "[not retained] <path> <ranges> · necromancy <id>";

export const RECALL_TOOL_DESCRIPTION =
  "Injects your memory with a toolcall result you choose to forget earlier. DO NOT use"
  + " unless you need that exact result AND the tool can no longer be re-run normally.";

/**
 * The shipped system prompt for the big prune's batched ask (ISSUE-022 chunk 3;
 * ADR-0009; rewritten to the owner-approved text by ISSUE-110, 2026-10-29).
 * One ask addresses every unit still in memory, so the answer is one object
 * keyed by the indices we assigned, not one verdict for one result.
 *
 * It is byte-identical across every ask of a run, so a provider can cache it for
 * the run, and it is pinned byte for byte by `test/assets.test.ts`. It is
 * deliberately absent from `MODEL_FACING_STRINGS`: that inventory is the receipt
 * and marker copy, and this asset must name the `summary` field the owner ruling
 * kept.
 *
 * ISSUE-110 replaced the shipped table prompt with the owner's approved
 * reshape, the voice ISSUE-106 proved live on the entry ask: one sentence
 * saying the row shape, then real answers a model can copy. Every `{"` line
 * below is a whole readable answer and `test/assets.test.ts` parses it through
 * `parsePruneAnswer` verbatim — a prompt whose example does not parse is the
 * bug that shipped a broken entry lane. Two paragraphs of the old prompt are
 * deliberately gone: the anchor-unavailable "keep it when in doubt" bias (the
 * recall net replaces the doubt clause) and the ~120-word row-format walk
 * (replaced by one sentence in the opener). Trailer-only summary spelling is
 * taught; the sibling `"summary"` form is the entry wire's (ADR-0033), not
 * this one's.
 */
const PRUNE_ASK_PROMPT_LINES: readonly string[] = [
  "Memory management: decide what tool results above stay in your memory. Answer about every result listed in the table below. Each row starts with the index you answer with, then the call that made it and quotes from that unit's own lines.",
  "",
  "Answer with exactly one JSON object and no other text. Each key is a row's index; its value is that unit's verdict:",
  "",
  '{"keepall":true}',
  '{"keeplines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}',
  '{"forgetall":"a stale build log from the old host"}',
  "",
  "Assembled by row index:",
  "",
  '{"1":{"keepall":true},"2":{"forgetall":"a stale build log from the old host"},"3":{"keeplines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}}',
  "",
  "keeplines keeps the named ranges (1-based, counted on that unit's own lines); the rest is replaced by a required summary, a few words, aim under 15, never over 25. forgetall replaces the whole unit with its summary. Answer every index exactly once; a missing, unknown or repeated key refuses that unit, and a refused unit keeps.",
  "",
  "Prune aggressively: drop anything the immediate task does not need; if you drop too much, the necromancy tool restores the exact bytes.",
];

/** Joined for the same purity-gate reason as the judge prompt above. */
export const PRUNE_ASK_SYSTEM_PROMPT = PRUNE_ASK_PROMPT_LINES.join("\n");

/**
 * The shipped prompt's opener and its last line, read from the asset itself so a
 * variant can never silently drop, reword or reorder either (ISSUE-129).
 */
const PRUNE_ASK_OPENER = PRUNE_ASK_PROMPT_LINES[0] ?? "";
const PRUNE_ASK_AGGRESSIVELY = PRUNE_ASK_PROMPT_LINES[PRUNE_ASK_PROMPT_LINES.length - 1] ?? "";

/**
 * The batch ask's two-option contract (ISSUE-129; the phase-3 A1 winner, the
 * live run's grammar). The shipped table contract above minus its line-level
 * option: the `keeplines` example, its assembled entry and the ranges teaching
 * are gone, replaced by one sentence saying plainly that a row is kept whole or
 * replaced whole. The opener, the assembled-answer form and the final "Prune
 * aggressively" line are the shipped prompt's own bytes.
 *
 * The text is the sim's `TWO_OPTION_PROMPT_LINES` word for word
 * (`dev/sim/sim-batch-grammar.mjs`), which was derived from this same asset.
 * Each `{"` line is a whole readable answer. Selected by
 * `entryAskGrammar: "two-option"`, the entry seam's second contract. It is NOT
 * the opencode table: that adapter sends the same `jsonl-20-nokeepall`
 * three-piece message dsh sends, and it applies a partial `keeplines` by
 * re-emitting the kept lines inside the typed result part (ISSUE-509;
 * ADR-0053 §Amendment 2026-11-23; ADR-0054 §Amendment 2026-11-19, corrected
 * 2026-11-23). Under this contract a row that names lines is refused
 * (`action-not-in-grammar`) and keeps, so the contract it teaches is the one
 * the parser admits.
 */
const PRUNE_ASK_TWO_OPTION_PROMPT_LINES: readonly string[] = [
  PRUNE_ASK_OPENER,
  "",
  "Answer with exactly one JSON object and no other text. Each key is a row's index; "
    + "its value is that unit's verdict:",
  "",
  '{"keepall":true}',
  '{"forgetall":"a stale build log from the old host"}',
  "",
  "Assembled by row index:",
  "",
  '{"1":{"keepall":true},"2":{"forgetall":"a stale build log from the old host"}}',
  "",
  "keepall keeps the whole result. forgetall replaces the whole result with its summary: a few "
    + "words, aim under 15, never over 25. There is no line-level option: a row is kept whole or "
    + "replaced whole, never partially. Answer every index exactly once; a missing, unknown or "
    + "repeated key refuses that unit, and a refused unit keeps.",
  "",
  PRUNE_ASK_AGGRESSIVELY,
];

/** Joined like the two prompts above; the batch ask reads it under `two-option`. */
export const PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT = PRUNE_ASK_TWO_OPTION_PROMPT_LINES.join("\n");

/**
 * The two-verdict grammars' whole-result note (ISSUE-221). `keepall` is not an
 * action there, so a whole result is stated as a `keeplines` over its whole
 * range with this exact forgotten value. The note is the same string on the
 * bulk ask and the entry ask, so one reader can recognise the form in both
 * places.
 */
export const KEEP_WHOLE_SUMMARY = "None";

/**
 * The one sentence both two-verdict prompts use to teach the keep-whole form.
 * It names no fixed range: the examples use small counts, and the rule says the
 * range ends at that row's own L, the count its `[L line(s)]` suffix shows.
 */
export const KEEP_WHOLE_RULE =
  "A whole result is kept by a keeplines answer over its whole range with forgotten "
  + `${KEEP_WHOLE_SUMMARY}; the range ends at that row's own L, the count its`
  + " [L line(s)] suffix shows.";

/**
 * The bulk prune ask's two-verdict contract (`pruneAskGrammar: "nokeepall"`):
 * the shipped index-keyed table ask with `keepall` removed. A row answers
 * `{"forgetall":"…"}` or `{"keeplines":[[start,end],"…"]}`; a whole unit is a
 * `keeplines` over its whole range with forgotten `None`. The opener names the
 * `[L line(s)]` count each row carries, because rule-free `keeplines` cannot
 * state a whole range without it. Every `{"` line is a whole readable answer
 * and `test/assets.test.ts` reads each one through `parsePruneAnswer`.
 */
const PRUNE_ASK_NOKEEPALL_PROMPT_LINES: readonly string[] = [
  "Memory management: decide what tool results above stay in your memory. Answer about every result listed in the table below. Each row starts with the index you answer with, then the call that made it and quotes from that unit's own lines, and ends with that unit's line count in [L line(s)] form.",
  "",
  "Answer with exactly one JSON object and no other text. Each key is a row's index; its value is that unit's verdict:",
  "",
  '{"forgetall":"a stale build log from the old host"}',
  '{"keeplines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}',
  "Whole row (the example row has 6 lines; use that row's own [L]):",
  `{"keeplines":[[1,6],"${KEEP_WHOLE_SUMMARY}"]}`,
  "",
  "Assembled by row index (row 2 is six lines here):",
  "",
  `{"1":{"forgetall":"a stale build log from the old host"},"2":{"keeplines":[[1,6],"${KEEP_WHOLE_SUMMARY}"]}}`,
  "",
  "keeplines keeps the named ranges (1-based, counted on that unit's own lines, inside 1..L); the rest is replaced by a required forgotten value, a few words, aim under 15, never over 25. forgetall replaces the whole unit with its forgotten value. "
    + KEEP_WHOLE_RULE
    + " Answer every index exactly once; a missing, unknown or repeated key refuses that unit, and a refused unit keeps.",
  "",
  "Prune aggressively: drop anything the immediate task does not need; if you drop too much, the necromancy tool restores the exact bytes.",
];

/** Joined like the shipped prompts; the bulk ask reads it under `nokeepall`. */
export const PRUNE_ASK_NOKEEPALL_SYSTEM_PROMPT =
  PRUNE_ASK_NOKEEPALL_PROMPT_LINES.join("\n");

/**
 * The entry ask's contract (ISSUE-056 chunk C2; rewritten 2026-10-28; repaired
 * by ISSUE-106 after the rewrite refused 42.9% of live answers). Static, so it
 * is byte-identical across every ask of a run and cacheable, and it rides
 * inside the one appended user message: the fork's system slot stays main's
 * (ADR-0010).
 *
 * The result has already landed above the ask, so this contract never repeats
 * its body. It states exactly three answer keys — the three the entry parser
 * accepts (`verdicts/entry-wire.ts`) — plus the two legal summary spellings of
 * one partial answer (ADR-0033), the `[start,end]` notation, what each key keeps
 * or purges, and how hard to prune. The fail-open rule stays in code and is not
 * restated here. No keep-first-N form: a first-N prefix is not an answer class
 * (ADR-0022 §9). The words the deleted size rule used (cap, capped) do not
 * appear; "summary" is the parser's own field name and is allowed by owner
 * ruling.
 *
 * ISSUE-106: every example line is a REAL answer — real numbers, a real short
 * summary, no `X`/`Y`/`<...>` token — because the placeholder template it
 * replaced was not valid JSON, and a prompt whose example does not parse is the
 * exact bug that shipped a broken lane. Each of the three lanes is twelve lines
 * and every one of them is exercised by `test/assets.test.ts` through
 * `parseEntryAnswer`, verbatim.
 *
 * The per-result lines follow this block at send time (`entryAskMessage`): the
 * range sentence naming `N`, then the shortened quotes.
 */
const ENTRY_ASK_PROMPT_LINES: readonly string[] = [
  "Memory management: decide what part of the tool result above stays in your memory. Answer about that result only.",
  "",
  "Answer with exactly one JSON object and no other text. One of three keys:",
  "",
  '{"keepall":true}',
  '{"keeplines":[[1,5],[9,12],"stale build log lines"]}',
  '{"keeplines":[[1,5],[9,12]],"summary":"stale build log lines"}',
  '{"forgetall":"one-line summary of the whole result"}',
  "",
  'keeplines keeps the named ranges (1-based, inclusive); the rest is replaced by a required summary that goes last in the array or in a sibling "summary" key, never both. A few words, aim under 15, never over 25. forgetall purges everything but the summary; keepall keeps every line.',
  "",
  "Prune aggressively: drop anything the immediate task does not need. If you drop too much, the necromancy tool restores the exact bytes.",
];

/** Joined for the same purity-gate reason as the judge prompt above. */
export const ENTRY_ASK_SYSTEM_PROMPT = ENTRY_ASK_PROMPT_LINES.join("\n");

/**
 * Lane F's contract (ADR-0027 §4): the entry ask above with `forgetlines` in
 * place of `keeplines`, so the arm admits exactly one partial class while
 * `keepall` and `forgetall` stay in both. Inert: nothing reads it unless a
 * caller selects the variant, so the shipped ask is still the default.
 *
 * The polarity is the whole difference: `forgetlines` purges the named ranges
 * and keeps the rest, so the summary describes what left. Exactly three lines
 * differ from the default's twelve (indices 5, 6 and 9), and each of them names
 * the class; every other byte is the default's own (ISSUE-106).
 */
const ENTRY_ASK_FORGETLINES_PROMPT_LINES: readonly string[] = [
  "Memory management: decide what part of the tool result above stays in your memory. Answer about that result only.",
  "",
  "Answer with exactly one JSON object and no other text. One of three keys:",
  "",
  '{"keepall":true}',
  '{"forgetlines":[[1,5],[9,12],"stale build log lines"]}',
  '{"forgetlines":[[1,5],[9,12]],"summary":"stale build log lines"}',
  '{"forgetall":"one-line summary of the whole result"}',
  "",
  'forgetlines purges the named ranges (1-based, inclusive), replaced by a required summary; the rest stays. It goes last in the array or in a sibling "summary" key, never both. A few words, aim under 15, never over 25. forgetall purges everything but the summary; keepall keeps every line.',
  "",
  "Prune aggressively: drop anything the immediate task does not need. If you drop too much, the necromancy tool restores the exact bytes.",
];

/** Joined like the two prompts above; T-8 adds it to the surface when a caller selects it. */
export const ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT = ENTRY_ASK_FORGETLINES_PROMPT_LINES.join("\n");

/**
 * The experiment's two-form contract: the default with `keepall` removed, its
 * example replaced by a `keeplines` whose ranges cover every line and whose
 * note is `"None"`, and one gloss line saying that this keeps the whole result.
 * Two keys remain — `keeplines` and `forgetall` — so a model that would have
 * kept everything states it through a full-range `keeplines` instead. Selected
 * only by `variant: 'twoform'`.
 *
 * Both legal spellings of that answer (ADR-0033) are shown, because a live run
 * answered in the trailer shape and every answer was refused. The gloss states
 * that EITHER form says nothing was dropped (ISSUE-106): a prompt whose gloss
 * read the sibling form as a partial plan would be teaching a trap.
 */
const ENTRY_ASK_TWOFORM_PROMPT_LINES: readonly string[] = [
  "Memory management: decide what part of the tool result above stays in your memory. Answer about that result only.",
  "",
  "Answer with exactly one JSON object and no other text. One of two keys:",
  "",
  `{"keeplines":[[1,201],"${KEEP_WHOLE_SUMMARY}"]}`,
  `{"keeplines":[[1,201]],"summary":"${KEEP_WHOLE_SUMMARY}"}`,
  '{"forgetall":"one-line summary of the whole result"}',
  `\`${KEEP_WHOLE_SUMMARY}\` says nothing was dropped: either keeplines line covers every line, so the whole result stays.`,
  "",
  'keeplines keeps the named ranges (1-based, inclusive); the rest is replaced by a required summary that goes last in the array or in a sibling "summary" key, never both. A few words, aim under 15, never over 25. forgetall purges everything but the summary.',
  "",
  "Prune aggressively: drop anything the immediate task does not need. If you drop too much, the necromancy tool restores the exact bytes.",
];

/** Joined like the three prompts above; `assets.ts` maps it to variant `twoform`. */
export const ENTRY_ASK_TWOFORM_SYSTEM_PROMPT = ENTRY_ASK_TWOFORM_PROMPT_LINES.join("\n");

/**
 * The framing line that introduced the result's block. Retained for the export
 * surface and the tests' byte pin, but unused by the body-free ask (ISSUE-058
 * P2): the result has already landed, so nothing in the ask brackets it. The
 * fence literals below are in the same position — kept, not rendered.
 */
export const ENTRY_ASK_FRAME =
  "The incoming tool result follows, copied verbatim between two fence lines.";

/**
 * The line that opened the result's block. Not a backtick fence: a code result
 * carries backticks. Not rendered by the body-free ask; see `ENTRY_ASK_FRAME`.
 */
export const ENTRY_ASK_RESULT_OPEN = "----- the result begins below, verbatim -----";

/** The line that closed the result's block. Not rendered by the body-free ask. */
export const ENTRY_ASK_RESULT_CLOSE = "----- the result ends above -----";

/**
 * The end anchor a bench or rig matcher keys on (ISSUE-056 C9a): a
 * random-looking literal, the LAST text of every entry ask, so a matcher anchors
 * on the message's end (`ENTRY_ASK_CLOSING_LINE` escaped, then `$`) instead of
 * searching for a phrase a result body could also carry.
 */
export const ENTRY_ASK_END_ANCHOR = "[[entry-ask-end:3f8b2d71c04e4a9db6e05c17]]";

/** The one closing instruction line: the action, then the end anchor. */
export const ENTRY_ASK_CLOSING_LINE =
  `Answer with one JSON object for the result above and nothing else. ${ENTRY_ASK_END_ANCHOR}`;

/**
 * `jsonl-20`'s forgetting-share line, verbatim (owner edit 2026-11-06). It is
 * now a PAIR: the session's first entry ask states the 70 percent share, and
 * every later ask states the 40 percent share. Both lines open on the same
 * "Prune aggressively: drop anything the immediate task does not need; they can
 * be restored anyway." sentence and then state one aggregate keep target; the
 * shorter share is the later trigger's, because by then the model has already
 * seen one fire and the context is the one that has to shrink further.
 *
 * Nothing enforces either number: the reader accepts keepall, forgetall and
 * keeplines freely. One fire picks one variant and states it in BOTH the
 * pre-table prompt and the post-table repeat, in these same bytes; the mount
 * decides which variant a fire is (its first entry ask, or a later one).
 */
const PRUNE_ASK_JSONL_20_FIRST_TARGET =
  "Prune aggressively: drop anything the immediate task does not need; they can be restored anyway. "
  + "Across all rows together, keep at most 70 percent of the total lines. You can keep some units "
  + "whole and forget others whole if that meets it.";
const PRUNE_ASK_JSONL_20_LATER_TARGET =
  "Prune aggressively: drop anything the immediate task does not need; they can be restored anyway. "
  + "Across all rows together, keep at most 40 percent of the total lines. You can keep some units "
  + "whole and forget others whole if that meets it.";

/**
 * The one line of the `jsonl-20` pre-table prompt that is a placeholder: the
 * rendered row table lands where this line stood, and the post-table repeat
 * follows it. The product's renderer, not the model, replaces it.
 */
export const PRUNE_ASK_JSONL_20_SLOT =
  "<rows: the table, one line per unit, each beginning with its index>";

/**
 * `jsonl-20`'s pre-table contract (ISSUE-143; ISSUE-183's shipped copy): one
 * JSON object per row per line, a short forgotten value beside the action key,
 * and the rules that make a bad line a row refusal instead of a batch refusal.
 *
 * LAYOUT. This block ends with `PRUNE_ASK_JSONL_20_SLOT`, the table's place;
 * `PRUNE_ASK_JSONL_20_REPEAT` follows the rendered table. The share line appears
 * in both blocks on purpose: once before the table and once after it. The
 * function takes the one variant a fire states, so the first trigger's 70
 * percent line and every later trigger's 40 percent line each appear twice,
 * never mixed inside one ask.
 *
 * The text is the simulator's `JSONL_20_PROMPT_LINES` word for word
 * (`dev/sim/sim-batch-grammar.mjs`), pinned byte for byte by
 * `test/entry-jsonl20.test.ts`. Do not paraphrase, reflow or "improve" it.
 */
const PRUNE_ASK_JSONL_20_PROMPT_LINES = (target: string): readonly string[] => [
  "Memory management: decide which tool results below stay in your memory. Forgotten ones are "
    + "purged, but can be restored later with a memory tool. Answer for every result in the table: "
    + "each row starts with the index you answer with, then the call that produced it, then quotes "
    + "from its own lines.",
  "",
  "Answer with one JSON object per row, one per line, and nothing else: no array, no commas "
    + "between lines, no markdown, no commentary. The key is that row's index as a string; the "
    + "value is that row's verdict, an object with exactly one action key.",
  "",
  "Rules:",
  "1. One object per line. One row per object. Nothing else on the line.",
  "2. Exactly one action key per row: keepall, forgetall, or keeplines.",
  "3. keepall carries nothing else. forgetall and keeplines must also carry forgotten: what is "
    + "being dropped and why.",
  "4. forgetall forgets the whole row. keeplines keeps the listed lines and forgets every line "
    + "not listed.",
  "5. keeplines is an ascending array of non-overlapping [start,end] pairs, integers, inside 1..L, "
    + "where L is that row's line count shown in the table.",
  "6. forgotten is one line of plain text, less than 20 words. It names what is being dropped and "
    + "why, so it can be recalled. It never describes the lines you keep. Use no raw newline. "
    + "Escape a double quote as \\\".",
  "7. Every row in the table appears exactly once. Add no other rows, keys, or text.",
  "8. Before sending, check each line: one object, one action key, forgotten present when "
    + "forgetting, ranges ascending and inside the row, and each line parses as JSON on its own.",
  "",
  "Answer format:",
  '{"N":{"keepall":true}}',
  '{"N":{"forgetall":true,"forgotten":"<forgotten>"}}',
  '{"N":{"keeplines":[[start,end], ...],"forgotten":"<forgotten>"}}',
  "Answer Example:",
  '{"1":{"keepall":true}}',
  '{"2":{"forgetall":true,"forgotten":"stale build log from the old host"}}',
  '{"3":{"keeplines":[[1,3],[11,18],[37,40]],"forgotten":"the stale build log and the old host block"}}',
  '{"4":{"keeplines":[[5,12]],"forgotten":"the imports and the stale fixture setup"}}',
  "",
  target,
  "",
  PRUNE_ASK_JSONL_20_SLOT,
];

/** The pre-table half of the first trigger's `jsonl-20` ask, joined as the sim joins it. */
export const PRUNE_ASK_JSONL_20_SYSTEM_PROMPT =
  PRUNE_ASK_JSONL_20_PROMPT_LINES(PRUNE_ASK_JSONL_20_FIRST_TARGET).join("\n");

/** The pre-table half of every later trigger's `jsonl-20` ask, same layout and bytes. */
export const PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT =
  PRUNE_ASK_JSONL_20_PROMPT_LINES(PRUNE_ASK_JSONL_20_LATER_TARGET).join("\n");

/**
 * The post-table half of the `jsonl-20` ask: the answer format, the four-row
 * worked example and the end anchor, restated after the table. It carries the
 * same share line as the pre-table prompt of the same fire, in the same bytes,
 * and the closing anchor stays the last thing the model reads.
 *
 * The text is the simulator's `JSONL_20_REPEAT_LINES` word for word
 * (`dev/sim/sim-batch-grammar.mjs`).
 */
const PRUNE_ASK_JSONL_20_REPEAT_LINES = (target: string): readonly string[] => [
  "Answer format:",
  '{"N":{"keepall":true}}',
  '{"N":{"forgetall":true,"forgotten":"<forgotten>"}}',
  '{"N":{"keeplines":[[start,end], ...],"forgotten":"<forgotten>"}}',
  "Answer Example:",
  '{"1":{"keepall":true}}',
  '{"2":{"forgetall":true,"forgotten":"stale build log from the old host"}}',
  '{"3":{"keeplines":[[1,3],[11,18],[37,40]],"forgotten":"the stale build log and the old host block"}}',
  '{"4":{"keeplines":[[5,12]],"forgotten":"the imports and the stale fixture setup"}}',
  "",
  target,
  "",
  ENTRY_ASK_END_ANCHOR,
];

/** The post-table half of the first trigger's `jsonl-20` ask, joined as the sim joins it. */
export const PRUNE_ASK_JSONL_20_REPEAT =
  PRUNE_ASK_JSONL_20_REPEAT_LINES(PRUNE_ASK_JSONL_20_FIRST_TARGET).join("\n");

/** The post-table half of every later trigger's `jsonl-20` ask, same layout and bytes. */
export const PRUNE_ASK_JSONL_20_LATER_REPEAT =
  PRUNE_ASK_JSONL_20_REPEAT_LINES(PRUNE_ASK_JSONL_20_LATER_TARGET).join("\n");

/**
 * `jsonl-20-nokeepall`'s share lines (ISSUE-221): `jsonl-20`'s two lines with
 * the sentence that allowed keeping some units whole and forgetting others whole
 * removed. The aggregate target and every other byte are unchanged.
 */
export const PRUNE_ASK_JSONL_20_NOKEEPALL_FIRST_TARGET =
  "Prune aggressively: drop anything the immediate task does not need; they can be restored anyway. "
  + "Across all rows together, keep at most 70 percent of the total lines.";
export const PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_TARGET =
  "Prune aggressively: drop anything the immediate task does not need; they can be restored anyway. "
  + "Across all rows together, keep at most 40 percent of the total lines.";

/**
 * The core port of the line-per-row two-verdict prompt (ISSUE-221): `jsonl-20`'s
 * rules with `keepall` removed from the action list, the formats and the worked
 * example. A whole row is the full-range `keeplines` with forgotten `None`. Every
 * `{"` line is a whole readable answer with real numbers, and
 * `test/assets.test.ts` reads each one through `readJsonl20Answer` with the
 * row's own L.
 */
const PRUNE_ASK_JSONL_20_NOKEEPALL_PROMPT_LINES = (target: string): readonly string[] => [
  "Memory management: decide which tool results below stay in your memory. Forgotten ones are "
    + "purged, but can be restored later with a memory tool. Answer for every result in the table: "
    + "each row starts with the index you answer with, then the call that produced it, then quotes "
    + "from its own lines.",
  "",
  "Answer with one JSON object per row, one per line, and nothing else: no array, no commas "
    + "between lines, no markdown, no commentary. The key is that row's index as a string; the "
    + "value is that row's verdict, an object with exactly one action key.",
  "",
  "Rules:",
  "1. One object per line. One row per object. Nothing else on the line.",
  "2. Exactly one action key per row: forgetall, or keeplines.",
  "3. forgetall and keeplines must also carry forgotten: what is being dropped and why.",
  "4. forgetall forgets the whole row. keeplines keeps the listed lines and forgets every line "
    + "not listed.",
  "5. keeplines is an ascending array of non-overlapping [start,end] pairs, integers, inside 1..L, "
    + "where L is that row's line count shown in the table. Use that row's own 1..L numbering, not "
    + "the line numbers printed inside the quoted content.",
  "6. forgotten is one line of plain text, less than 20 words. It names what is being dropped and "
    + "why, so it can be recalled. It never describes the lines you keep. Use no raw newline. "
    + "Escape a double quote as \\\".",
  "7. Every row in the table appears exactly once. Add no other rows, keys, or text.",
  "8. Before sending, check each line: one object, one action key, forgotten present when "
    + "forgetting, ranges ascending and inside the row, and each line parses as JSON on its own, "
    + "with both closing braces — the row object and its verdict object.",
  `9. ${KEEP_WHOLE_RULE}`,
  "",
  "Answer format:",
  '{"1":{"forgetall":true,"forgotten":"stale build log from the old host"}}',
  "Row 2 has 6 lines here; a whole row uses its own L:",
  `{"2":{"keeplines":[[1,6]],"forgotten":"${KEEP_WHOLE_SUMMARY}"}}`,
  '{"3":{"keeplines":[[1,3],[11,18]],"forgotten":"the stale build log and the old host block"}}',
  "Answer Example:",
  "Row 1 has 6 lines here; a whole row uses its own L:",
  `{"1":{"keeplines":[[1,6]],"forgotten":"${KEEP_WHOLE_SUMMARY}"}}`,
  '{"2":{"forgetall":true,"forgotten":"stale build log from the old host"}}',
  '{"3":{"keeplines":[[1,3],[11,18],[37,40]],"forgotten":"the stale build log and the old host block"}}',
  '{"4":{"keeplines":[[5,12]],"forgotten":"the imports and the stale fixture setup"}}',
  'Never: {"1":{"forgetall":true},"2":{"forgetall":true}} — one object naming two rows is invalid.',
  "Each row is its own line.",
  "",
  target,
  "",
  PRUNE_ASK_JSONL_20_SLOT,
];

/** The first trigger's pre-table half, joined as the batch ask joins it. */
export const PRUNE_ASK_JSONL_20_NOKEEPALL_SYSTEM_PROMPT =
  PRUNE_ASK_JSONL_20_NOKEEPALL_PROMPT_LINES(PRUNE_ASK_JSONL_20_NOKEEPALL_FIRST_TARGET).join("\n");

/** Every later trigger's pre-table half, same layout and bytes. */
export const PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_SYSTEM_PROMPT =
  PRUNE_ASK_JSONL_20_NOKEEPALL_PROMPT_LINES(PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_TARGET).join("\n");

/**
 * The post-table half of the two-verdict entry ask: the same two verdicts,
 * restated after the table, with the closing anchor last.
 */
const PRUNE_ASK_JSONL_20_NOKEEPALL_REPEAT_LINES = (target: string): readonly string[] => [
  "Answer format:",
  '{"1":{"forgetall":true,"forgotten":"stale build log from the old host"}}',
  "Row 2 has 6 lines here; a whole row uses its own L:",
  `{"2":{"keeplines":[[1,6]],"forgotten":"${KEEP_WHOLE_SUMMARY}"}}`,
  '{"3":{"keeplines":[[1,3],[11,18]],"forgotten":"the stale build log and the old host block"}}',
  "Answer Example:",
  "Row 1 has 6 lines here; a whole row uses its own L:",
  `{"1":{"keeplines":[[1,6]],"forgotten":"${KEEP_WHOLE_SUMMARY}"}}`,
  '{"2":{"forgetall":true,"forgotten":"stale build log from the old host"}}',
  '{"3":{"keeplines":[[1,3],[11,18],[37,40]],"forgotten":"the stale build log and the old host block"}}',
  '{"4":{"keeplines":[[5,12]],"forgotten":"the imports and the stale fixture setup"}}',
  'Never: {"1":{"forgetall":true},"2":{"forgetall":true}} — one object naming two rows is invalid.',
  "Each row is its own line.",
  "",
  target,
  "",
  ENTRY_ASK_END_ANCHOR,
];

/** The first trigger's post-table repeat. */
export const PRUNE_ASK_JSONL_20_NOKEEPALL_REPEAT =
  PRUNE_ASK_JSONL_20_NOKEEPALL_REPEAT_LINES(PRUNE_ASK_JSONL_20_NOKEEPALL_FIRST_TARGET).join("\n");

/** Every later trigger's post-table repeat. */
export const PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_REPEAT =
  PRUNE_ASK_JSONL_20_NOKEEPALL_REPEAT_LINES(PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_TARGET).join("\n");

export const MODEL_FACING_STRINGS: readonly string[] = [
  SHAPE_MARKER_TEMPLATE,
  SHAPE_MARKER_EMPTY_TEMPLATE,
  NEGATIVE_FACT_TEMPLATE,
  NONE_MATCHED,
  EMPTY_NEGATIVE_FACT_TEMPLATE,
  SPAN_MARKER_TEMPLATE,
  RECEIPT_TEMPLATE,
  RECEIPT_FLOOR_TEMPLATE,
  RECALL_TOOL_DESCRIPTION,
  " lines",
  " bytes",
];
