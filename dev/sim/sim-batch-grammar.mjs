#!/usr/bin/env node
/**
 * The batch ask's six grammars (trigger-prompting study, phases 3 and 5; SIM ONLY).
 *
 * One id picks the whole ask/answer pair; nothing outside `dev/sim` reads it.
 *
 * - `3option` is the original shipped ask, byte for byte: the call is
 *   `entryBatchAskMessage` and the reading is `parseEntryBatchAnswer`, exactly as
 *   `packages/core/src/entry/batch-ask.ts` composes and reads them. Every other
 *   function here exists so this id can be proven byte-identical, not replaced.
 *   It is selectable, but it is NOT the product default: `jsonl-20` is
 *   (`batch-ask.ts` `DEFAULT_ENTRY_ASK_GRAMMAR`, owner ruling 2026-11-05).
 * - `two-option` (arm A1) has no line-level option at all: a row is
 *   `{"keepall":true}` or `{"forgetall":"one-line summary"}`, and a row that
 *   answers anything else is a row-level parse refusal (`action-not-in-grammar`)
 *   that keeps the unit. No range can be wrong, so no arithmetic refusal exists:
 *   only parse refusals remain, and the correction turn never fires.
 * - `forgetlines` (arm A2) names the lines that LEAVE: `{"forgetlines":[[s,e],
 *   "one-line summary"]}` marks the ranges to remove, its summary describes
 *   exactly those lines, and every unmarked line stays on the surface. Ranges
 *   are checked against the row's own line count here, because the wire parser
 *   never sees the unit: out-of-range spans and a full-range forget earn the one
 *   correction turn, the same way `spans-outside-result` and `keeps-every-line`
 *   do for `keeplines`.
 * - `keeplines-60` (arm B) offers the two shipped actions and nothing else: a
 *   row answers `{"keeplines":[[s,e],...,"summary"]}` or
 *   `{"forgetall":"summary"}`, and `keepall` or `forgetlines` is
 *   `action-not-in-grammar` and keeps. Two rules differ from the shipped
 *   reading. First, a `keeplines` that names every line is ACCEPTED as
 *   keep-whole: the per-row kept fraction is not constrained, so "keep this
 *   whole unit, forget the next whole" is expressible, and only an out-of-range
 *   span still earns the correction turn. Second, the summary cap is 250 words,
 *   not the wire parser's 25, so a row the shipped reader refuses
 *   `summary-too-long` is re-read here under the wider cap with the repo's own
 *   count (`descriptorWordCount`); past 250 it is refused `summary-too-long` at
 *   parse level, the row keeps, and no correction turn fires. The 60 percent
 *   forget target lives in the instruction only: the run records the aggregate
 *   kept fraction and nothing enforces it.
 * - `jsonl-20` (ISSUE-143; the product default) answers ONE JSON object per row
 *   per line: `{"N":{"keepall":true}}`,
 *   `{"N":{"forgetall":true,"summary":"..."}}` or
 *   `{"N":{"keeplines":[[s,e],...],"summary":"..."}}`. Its reader is CORE's
 *   `readJsonl20Answer` (`entry/jsonl-20-answer.ts`), called directly: the sim
 *   keeps no copy, so the per-line rules, the refusal vocabulary and every
 *   action shape are the shipped ones by construction. The prompt asks for a
 *   summary under 20 words and the shipped reader tolerates up to 30. Its prompt
 *   carries the row table as a slot (`<rows: the table, ...>`), so the table is
 *   rendered in place and no ask order applies.
 * - `jsonl-20-nokeepall` (ISSUE-221) is `jsonl-20` with one action removed: a
 *   row answers `{"N":{"forgetall":true,"summary":"..."}}` or
 *   `{"N":{"keeplines":[[s,e],...],"summary":"..."}}`, and a `keepall` row is
 *   the sim's own `action-not-in-grammar` refusal that keeps the unit. Keeping
 *   a whole row is taught as a `keeplines` over its whole range
 *   (`{"N":{"keeplines":[[1,120]],"summary":"all kept"}}`), which the reader
 *   accepts as keep-whole. Its share lines drop the sentence that allowed
 *   keeping some units whole and forgetting others whole. Everything else —
 *   the wire, the rules, the summary cap, the slot and the anchors — is
 *   `jsonl-20`'s.
 *
 * Request shape, closing anchor (`ENTRY_ASK_CLOSING_LINE` last), scoring and
 * booking are the same for all six: only the instruction text and the answer
 * reading move. A reversed or fractional span is refused by the wire parser as
 * `invalid-span` (`malformed-row`) before any arithmetic runs, so it is a parse
 * refusal and never earns the correction turn.
 *
 * ORDER (phase 4). `--ask-order` places the SAME teaching block around the row
 * table and composes with every grammar whose table is a separate piece.
 * `jsonl-20` is the exception: its prompt embeds the table as a slot, so it
 * renders in place and only `first` applies (the launchers refuse the other two
 * by name).
 *
 * - `first` (default) is today's layout, `${instruction}\n\n${rows}\n\n${closing}`;
 *   under `3option` it delegates to the shipped composer, so the default bytes
 *   cannot drift.
 * - `after` is `${rows}\n\n${instruction}\n\n${closing}`.
 * - `both` is `${instruction}\n\n${rows}\n\n${instruction}\n\n${closing}`, the
 *   block repeated word for word (the vendor guidance to repeat an instruction
 *   at the end).
 *
 * The closing anchor is last in all three, and the block is never reworded for
 * its position: the shipped opener's "listed in the table below" therefore stays
 * true in `first` and in `both`'s first copy and reads stale in `after` and in
 * `both`'s second copy. That is recorded, not patched, so the arms differ by
 * position and nothing else; phase 4 reads the comparison as a position effect
 * on the same words.
 *
 * Pure and deterministic; no I/O, no socket. Invalid ids throw a `RangeError`
 * (a caller bug); the launchers refuse `--ask-grammar`/`--ask-order` earlier by
 * name.
 */
import {
  ENTRY_ASK_CLOSING_LINE, ENTRY_ASK_END_ANCHOR, JSONL_20_CLOSING_PREFIX, JSONL_20_REFUSAL_CODES,
  JSONL_20_SUMMARY_WORDS, PRUNE_ASK_SYSTEM_PROMPT, descriptorWordCount,
  entryAskFactsBlock, entryBatchAskMessage, jsonl20MessageOf as coreJsonl20MessageOf,
  jsonl20RejectionsOf as coreJsonl20RejectionsOf, normalizeKeptSpans, parseEntryBatchAnswer,
  parsePruneAnswer, readJsonl20Answer, renderPruneAskRows,
} from "@cremator/core";

export { JSONL_20_CLOSING_PREFIX, JSONL_20_REFUSAL_CODES, JSONL_20_SUMMARY_WORDS };

/** The six grammar ids, as `--ask-grammar` spells them. */
export const ASK_GRAMMARS = Object.freeze([
  "3option", "two-option", "forgetlines", "keeplines-60", "jsonl-20", "jsonl-20-nokeepall",
]);
/** The grammars whose prompt carries its row table as a slot: the table renders
 * in place, so no ask order applies and the line-count suffix is theirs alone. */
export const SLOT_GRAMMARS = Object.freeze(new Set(["jsonl-20", "jsonl-20-nokeepall"]));
/** The product's default ask (`batch-ask.ts` `DEFAULT_ENTRY_ASK_GRAMMAR`), so a
 * run that names no grammar measures the shape a default product run sends. */
export const DEFAULT_ASK_GRAMMAR = "jsonl-20";
/** The three instruction positions, as `--ask-order` spells them. */
export const ASK_ORDERS = ["first", "after", "both"];
/** Today's layout: the instruction, the rows, the closing line. */
export const DEFAULT_ASK_ORDER = "first";

/**
 * The code a row earns when it answers a shape this grammar does not offer. It
 * is the sim's own code, never a product refusal code: `ask-answer.ts` knows only
 * the five parse codes, and this one is added above them by the experiment.
 */
export const GRAMMAR_GATE_CODE = "action-not-in-grammar";

/**
 * The code a `keeplines-60` row earns when its summary runs past the arm's own
 * cap. It is the product's code name (`entry-wire.ts`'s "summary-too-long")
 * raised at a wider limit, so a journal and a report read it the same way.
 */
export const SUMMARY_TOO_LONG_CODE = "summary-too-long";

/**
 * The `keeplines-60` summary cap, in words. The prompt asks for under 200 and
 * never over 200; the reader accepts up to and including 250 and refuses above.
 * The count is `descriptorWordCount`, the repo's ONE summary word count
 * (`verdicts/labels.ts`): line breaks collapse to spaces, trim, then split on
 * whitespace. The shipped 25-word cap is `RECEIPT_DESCRIPTOR_WORD_LIMIT`; this
 * arm is the same counter with this number.
 */
export const KEEPLINES_60_SUMMARY_WORDS = 250;

/**
 * The `jsonl-20` summary tolerance, in words. The prompt asks for under 20; the
 * shipped reader tolerates up to and including 30 and refuses above. The
 * constant is CORE's (`JSONL_20_SUMMARY_WORDS`, re-exported above): the sim
 * keeps no second copy of the reader's own limit.
 */

/**
 * The one line of the `jsonl-20` prompt that is a placeholder: the rendered row
 * table lands where this line stood, and the post-table repeat follows it. It is
 * not part of the reader's vocabulary; a row line starts with the index.
 */
export const JSONL_20_SLOT = "<rows: the table, one line per unit, each beginning with its index>";

/** The actions each grammar admits; `3option` admits the parser's own four. */
const ADMITTED = Object.freeze({
  "3option": Object.freeze(["keepall", "keeplines", "forgetlines", "forgetall"]),
  "two-option": Object.freeze(["keepall", "forgetall"]),
  "forgetlines": Object.freeze(["keepall", "forgetall", "forgetlines"]),
  "keeplines-60": Object.freeze(["keeplines", "forgetall"]),
  "jsonl-20": Object.freeze(["keepall", "forgetall", "keeplines"]),
  "jsonl-20-nokeepall": Object.freeze(["forgetall", "keeplines"]),
});

/**
 * The shipped prompt's first and last lines, read from the asset itself so a
 * variant can never silently drop, reword or reorder them: A1 and A2 keep the
 * opener and the "Prune aggressively" line as they are.
 */
const SHIPPED_LINES = PRUNE_ASK_SYSTEM_PROMPT.split("\n");
const OPENER = SHIPPED_LINES[0];
const AGGRESSIVELY = SHIPPED_LINES[SHIPPED_LINES.length - 1];
const CONTRACT_HEAD =
  "Answer with exactly one JSON object and no other text. Each key is a row's index; "
  + "its value is that unit's verdict:";
const FORGET_EXAMPLE = '{"forgetall":"a stale build log from the old host"}';

/**
 * A1's contract: two examples, one assembled answer, and a sentence that says
 * plainly that no line-level option exists. The `keeplines` example, the
 * assembled `keeplines` entry and the ranges sentence are gone.
 */
const TWO_OPTION_PROMPT_LINES = Object.freeze([
  OPENER,
  "",
  CONTRACT_HEAD,
  "",
  '{"keepall":true}',
  FORGET_EXAMPLE,
  "",
  "Assembled by row index:",
  "",
  `{"1":{"keepall":true},"2":${FORGET_EXAMPLE}}`,
  "",
  "keepall keeps the whole result. forgetall replaces the whole result with its summary: a few "
    + "words, aim under 15, never over 25. There is no line-level option: a row is kept whole or "
    + "replaced whole, never partially. Answer every index exactly once; a missing, unknown or "
    + "repeated key refuses that unit, and a refused unit keeps.",
  "",
  AGGRESSIVELY,
]);

/**
 * A2's contract: `keeplines` becomes `forgetlines` in the example, in the
 * assembled answer and in the teaching sentence, and the sentence states the
 * direction twice so the flip cannot be read backwards: the named lines are what
 * is REMOVED, the summary describes exactly them, and everything unnamed stays.
 */
const FORGETLINES_PROMPT_LINES = Object.freeze([
  OPENER,
  "",
  CONTRACT_HEAD,
  "",
  '{"keepall":true}',
  '{"forgetlines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}',
  FORGET_EXAMPLE,
  "",
  "Assembled by row index:",
  "",
  '{"1":{"keepall":true},"2":{"forgetall":"a stale build log from the old host"},'
    + '"3":{"forgetlines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}}',
  "",
  "forgetlines drops the named ranges (1-based, counted on that unit's own lines) and keeps every "
    + "other line; what leaves is replaced by a required summary that describes exactly those "
    + "removed lines: a few words, aim under 15, never over 25. The named lines are what is REMOVED "
    + "— every line you do not name stays on the surface. forgetall replaces the whole unit with "
    + "its summary. Answer every index exactly once; a missing, unknown or repeated key refuses "
    + "that unit, and a refused unit keeps.",
  "",
  AGGRESSIVELY,
]);

/**
 * Arm B's contract: the shipped opener and last line, the shipped contract head,
 * and TWO actions — `keeplines` and `forgetall`. `keepall` is absent from the
 * examples and from the sentence, so a row that answers it is
 * `action-not-in-grammar`. The ranges sentence says what `keeplines` KEEPS (the
 * shipped direction), the summary band is 50/200 words, and the 60 percent
 * forget target is stated as an aggregate the agent may meet by keeping some
 * units whole and forgetting others whole.
 */
const KEEPLINES_60_PROMPT_LINES = Object.freeze([
  OPENER,
  "",
  CONTRACT_HEAD,
  "",
  '{"keeplines":[[2,3],[8,9],"stale run notes: the superseded TODO and the old deploy host"]}',
  FORGET_EXAMPLE,
  "",
  "Assembled by row index:",
  "",
  '{"1":{"forgetall":"generated migration output from the old schema"},'
    + '"2":{"keeplines":[[1,2],[12,13],[27,28],"the two env vars and the deploy command"]}}',
  "",
  "Each row takes keeplines (keep the named ranges, 1-based, counted on that unit's own lines; "
    + "the rest is replaced by a required summary; the summary is the last element inside the "
    + "array) or forgetall (replace the whole result with its summary). A summary should be short: "
    + "aim under 50 words, never over 200. Across all rows together, forget at least 60 percent of "
    + "the total lines: keep some units whole and forget "
    + "others whole if that meets it. Answer every index exactly once; a missing, unknown or "
    + "repeated key refuses that unit, and a refused unit keeps.",
  "",
  AGGRESSIVELY,
]);

/**
 * The `jsonl-20` share line, verbatim, in its two variants (owner edit
 * 2026-11-06). The session's FIRST fire states the 70 percent keep target; every
 * later fire states 40 percent. Both open on the same "Prune aggressively"
 * sentence and state one aggregate keep target, and nothing enforces either
 * number: the reader accepts keepall, forgetall and keeplines freely.
 *
 * This is the simulator's copy of the product's own constants
 * (`packages/core/src/rules/assets-templates.ts`). Two tests compare the bytes:
 * `packages/core/test/entry-jsonl20.test.ts` compares the assembled asks in
 * both variants, and `dev/sim/sim-batch-units.test.mjs` compares this module's
 * prompt and repeat against `PRUNE_ASK_JSONL_20_SYSTEM_PROMPT` /
 * `PRUNE_ASK_JSONL_20_REPEAT` and their `LATER` twins. A reflow on either side
 * is red.
 */
export const JSONL_20_FIRST_TARGET =
  "Prune aggressively: drop anything the immediate task does not need; they can be restored anyway. "
  + "Across all rows together, keep at most 70 percent of the total lines. You can keep some units "
  + "whole and forget others whole if that meets it.";
export const JSONL_20_LATER_TARGET =
  "Prune aggressively: drop anything the immediate task does not need; they can be restored anyway. "
  + "Across all rows together, keep at most 40 percent of the total lines. You can keep some units "
  + "whole and forget others whole if that meets it.";

/**
 * `jsonl-20`'s contract, verbatim (ISSUE-143): one JSON object per row per line,
 * a short summary beside the action key, and the rules that make a bad line a
 * row refusal instead of a batch refusal.
 *
 * LAYOUT. This block is the PRE-TABLE prompt and ends with `JSONL_20_SLOT`, the
 * table's place. `JSONL_20_REPEAT_LINES` is the POST-TABLE repeat: the answer
 * format, the examples, and the end anchor on its own last line. The share line
 * appears in both blocks on purpose: once before the table and once after it,
 * and both copies are the SAME fire's variant (ISSUE-194).
 */
const JSONL_20_PROMPT_LINES = target => Object.freeze([
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
  JSONL_20_SLOT,
]);

/**
 * The POST-TABLE half of the `jsonl-20` ask: the answer format, the examples and
 * the end anchor, restated after the table. It carries the same share line as
 * the pre-table prompt of the same fire, in the same bytes, and the closing
 * anchor stays the last thing the model reads.
 */
const JSONL_20_REPEAT_LINES = target => Object.freeze([
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
]);

/**
 * The two `jsonl-20` halves, per trigger variant (ISSUE-194). `first` is the
 * session's first fire (70 percent keep target); `later` is every later fire
 * (40 percent). Both halves of one fire always come from the same variant.
 */
export const JSONL_20_VARIANTS = Object.freeze({
  first: Object.freeze({
    prompt: JSONL_20_PROMPT_LINES(JSONL_20_FIRST_TARGET).join("\n"),
    repeat: JSONL_20_REPEAT_LINES(JSONL_20_FIRST_TARGET).join("\n"),
  }),
  later: Object.freeze({
    prompt: JSONL_20_PROMPT_LINES(JSONL_20_LATER_TARGET).join("\n"),
    repeat: JSONL_20_REPEAT_LINES(JSONL_20_LATER_TARGET).join("\n"),
  }),
});

/**
 * The `jsonl-20-nokeepall` share lines (ISSUE-221): the `jsonl-20` lines with
 * the sentence that allowed some units whole and others forgotten whole
 * removed. The aggregate target, the opener and every other byte are unchanged.
 */
export const JSONL_20_NOKEEPALL_FIRST_TARGET =
  "Prune aggressively: drop anything the immediate task does not need; they can be restored anyway. "
  + "Across all rows together, keep at most 70 percent of the total lines.";
export const JSONL_20_NOKEEPALL_LATER_TARGET =
  "Prune aggressively: drop anything the immediate task does not need; they can be restored anyway. "
  + "Across all rows together, keep at most 40 percent of the total lines.";

/**
 * `jsonl-20-nokeepall`'s pre-table prompt: `jsonl-20`'s bytes with `keepall`
 * removed from the rule list, from the answer format and from the example. The
 * keep-everything shape is `{"N":{"keeplines":[[1,120]],"forgotten":"None"}}`
 * — a `keeplines` over the whole range, which the reader accepts as keep-whole.
 * Every other rule, example, the forgotten cap, the slot and the anchors are
 * `jsonl-20`'s.
 */
const JSONL_20_NOKEEPALL_PROMPT_LINES = target => Object.freeze([
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
    + "where L is that row's line count shown in the table.",
  "6. forgotten is one line of plain text, less than 20 words. It names what is being dropped and "
    + "why, so it can be recalled. It never describes the lines you keep. Use no raw newline. "
    + "Escape a double quote as \\\".",
  "7. Every row in the table appears exactly once. Add no other rows, keys, or text.",
  "8. Before sending, check each line: one object, one action key, forgotten present when "
    + "forgetting, ranges ascending and inside the row, and each line parses as JSON on its own.",
  "",
  "Answer format:",
  '{"N":{"keeplines":[[1,120]],"forgotten":"None"}}',
  '{"N":{"forgetall":true,"forgotten":"<forgotten>"}}',
  '{"N":{"keeplines":[[start,end], ...],"forgotten":"<forgotten>"}}',
  "Answer Example:",
  '{"1":{"keeplines":[[1,120]],"forgotten":"None"}}',
  '{"2":{"forgetall":true,"forgotten":"stale build log from the old host"}}',
  '{"3":{"keeplines":[[1,3],[11,18],[37,40]],"forgotten":"the stale build log and the old host block"}}',
  '{"4":{"keeplines":[[5,12]],"forgotten":"the imports and the stale fixture setup"}}',
  "",
  target,
  "",
  JSONL_20_SLOT,
]);

/**
 * The POST-TABLE half of the `jsonl-20-nokeepall` ask: `jsonl-20`'s repeat with
 * the keep-everything example spelled as a whole-range `keeplines` and the
 * share line's keep-whole sentence removed. The closing anchor stays last.
 */
const JSONL_20_NOKEEPALL_REPEAT_LINES = target => Object.freeze([
  "Answer format:",
  '{"N":{"keeplines":[[1,120]],"forgotten":"None"}}',
  '{"N":{"forgetall":true,"forgotten":"<forgotten>"}}',
  '{"N":{"keeplines":[[start,end], ...],"forgotten":"<forgotten>"}}',
  "Answer Example:",
  '{"1":{"keeplines":[[1,120]],"forgotten":"None"}}',
  '{"2":{"forgetall":true,"forgotten":"stale build log from the old host"}}',
  '{"3":{"keeplines":[[1,3],[11,18],[37,40]],"forgotten":"the stale build log and the old host block"}}',
  '{"4":{"keeplines":[[5,12]],"forgotten":"the imports and the stale fixture setup"}}',
  "",
  target,
  "",
  ENTRY_ASK_END_ANCHOR,
]);

/** The two `jsonl-20-nokeepall` halves, per trigger variant. */
export const JSONL_20_NOKEEPALL_VARIANTS = Object.freeze({
  first: Object.freeze({
    prompt: JSONL_20_NOKEEPALL_PROMPT_LINES(JSONL_20_NOKEEPALL_FIRST_TARGET).join("\n"),
    repeat: JSONL_20_NOKEEPALL_REPEAT_LINES(JSONL_20_NOKEEPALL_FIRST_TARGET).join("\n"),
  }),
  later: Object.freeze({
    prompt: JSONL_20_NOKEEPALL_PROMPT_LINES(JSONL_20_NOKEEPALL_LATER_TARGET).join("\n"),
    repeat: JSONL_20_NOKEEPALL_REPEAT_LINES(JSONL_20_NOKEEPALL_LATER_TARGET).join("\n"),
  }),
});

/** The variant prompts, joined exactly as the shipped asset joins its lines. */
export const ASK_GRAMMAR_PROMPTS = Object.freeze({
  "two-option": TWO_OPTION_PROMPT_LINES.join("\n"),
  forgetlines: FORGETLINES_PROMPT_LINES.join("\n"),
  "keeplines-60": KEEPLINES_60_PROMPT_LINES.join("\n"),
  "jsonl-20": JSONL_20_PROMPT_LINES(JSONL_20_FIRST_TARGET).join("\n"),
  "jsonl-20-nokeepall":
    JSONL_20_NOKEEPALL_PROMPT_LINES(JSONL_20_NOKEEPALL_FIRST_TARGET).join("\n"),
});

/** The canonical id, or a `RangeError` when the caller names no grammar. */
export function checkGrammar(grammar = DEFAULT_ASK_GRAMMAR) {
  if (typeof grammar !== "string" || !ASK_GRAMMARS.includes(grammar)) {
    throw new RangeError(
      `the ask grammar ${String(grammar)} is not one of ${ASK_GRAMMARS.join(", ")}`,
    );
  }
  return grammar;
}

/** The canonical order, or a `RangeError` when the caller names no position. */
export function checkOrder(order = DEFAULT_ASK_ORDER) {
  if (typeof order !== "string" || !ASK_ORDERS.includes(order)) {
    throw new RangeError(
      `the ask order ${String(order)} is not one of ${ASK_ORDERS.join(", ")}`,
    );
  }
  return order;
}

/**
 * The teaching block one grammar ships, byte for byte. `3option` is the shipped
 * prompt asset itself; a variant is its assembled line list. Moving a block never
 * rewrites it, so the same bytes can sit before the table, after it, or both.
 */
export function instructionOf(grammar = DEFAULT_ASK_GRAMMAR) {
  const checked = checkGrammar(grammar);
  return checked === "3option" ? PRUNE_ASK_SYSTEM_PROMPT : ASK_GRAMMAR_PROMPTS[checked];
}

/**
 * The batch ask for one fire's rows (`askRowsOf`'s shape: `index`, `call`,
 * `lineCount`, `anchorLines`), under one grammar, one instruction order and one
 * trigger variant. `first` + `3option` delegates to the shipped composer, so the
 * default bytes cannot drift; every other pair is the same three pieces placed
 * by `order`: the block, the rows, the closing line.
 *
 * `firstTrigger` (ISSUE-194) is `jsonl-20`'s alone: `true` is the session's
 * first fire and states the 70 percent share line, `false` is every later fire
 * and states 40 percent. The other grammars have no per-fire line, so their
 * bytes are the same whichever way it is passed. The default is `true` — a
 * caller that says nothing is asking about a first fire.
 *
 * A one-row batch under a non-default order or grammar is the table-row shape
 * (`index. [call] — quotes`), not `entryAskMessage`'s prose shape: the
 * delegation above is the only path that ships those bytes, and phase 4 runs on
 * `two-option`, which never reaches it.
 */
export function askMessageForRows(rows, grammar = DEFAULT_ASK_GRAMMAR,
  order = DEFAULT_ASK_ORDER, firstTrigger = true) {
  const checked = checkGrammar(grammar);
  const placed = checkOrder(order);
  if (SLOT_GRAMMARS.has(checked)) {
    // The slot fixes the layout: there is no separate block to move. A caller
    // asking for another position is a bug, refused before any byte is built.
    if (placed !== DEFAULT_ASK_ORDER) {
      throw new RangeError(
        `the ${checked} ask renders its own table slot; the order ${placed} does not apply`,
      );
    }
    return jsonlSlotAskOf(rows, variantsOf(checked), firstTrigger, checked);
  }
  if (placed === DEFAULT_ASK_ORDER && checked === "3option") {
    return entryBatchAskMessage(rows, "3option");
  }
  const instruction = instructionOf(checked);
  const table = renderPruneAskRows(rendererRowsOf(rows));
  if (placed === "after") return `${table}\n\n${instruction}\n\n${ENTRY_ASK_CLOSING_LINE}`;
  if (placed === "both") {
    return `${instruction}\n\n${table}\n\n${instruction}\n\n${ENTRY_ASK_CLOSING_LINE}`;
  }
  return `${instruction}\n\n${table}\n\n${ENTRY_ASK_CLOSING_LINE}`;
}

/**
 * `jsonl-20`'s ask: the pre-table prompt with its table slot replaced by the
 * rendered rows, then the post-table repeat. The three pieces are fixed, so the
 * source states the layout the render produces: prompt, table, repeat.
 *
 * `firstTrigger` picks the fire's variant (ISSUE-194); both halves come from the
 * same one, so one message never mixes the 70 percent and 40 percent lines.
 *
 * Every row line ends with that row's line count, because the prompt's rule 5
 * makes a `keeplines` bound refer to "L ... shown in the table". The suffix is
 * these grammars' alone: no other table gains it.
 */
function jsonlSlotAskOf(rows, variantSet, firstTrigger = true, grammar = "jsonl-20") {
  const variant = firstTrigger ? variantSet.first : variantSet.later;
  const preTable = variant.prompt;
  if (!preTable.includes(JSONL_20_SLOT)) {
    throw new RangeError(`the ${grammar} prompt lost its table slot`);
  }
  const repeat = variant.repeat;
  const rendered = rendererRowsOf(rows);
  const counts = new Map(rows.map(row => [row.index, row.lineCount]));
  const table = rendered.map(row =>
    `${renderPruneAskRows([row])}${jsonl20LineCountLabelOf(counts.get(row.index), row.index)}`)
    .join("\n");
  // A function replacement, never a string: the table is transcript text, and a
  // string replacement would expand `$&`, `` $` ``, `$'` and `$$` in it.
  return `${preTable.replace(JSONL_20_SLOT, () => table)}\n\n${repeat}`;
}

/** The two prompt/repeat halves a slot grammar ships, per trigger variant. */
function variantsOf(grammar) {
  return grammar === "jsonl-20-nokeepall" ? JSONL_20_NOKEEPALL_VARIANTS : JSONL_20_VARIANTS;
}

/**
 * The `[N line(s)]` suffix one `jsonl-20` row line carries. A missing count is a
 * caller bug, never a blank suffix: the prompt promises every row shows its L.
 */
function jsonl20LineCountLabelOf(lineCount, index) {
  if (!Number.isSafeInteger(lineCount) || lineCount < 1) {
    throw new RangeError(`the jsonl-20 table needs index ${String(index)}'s line count`);
  }
  return ` [${String(lineCount)} line${lineCount === 1 ? "" : "s"}]`;
}

/**
 * Reads one answer under a grammar: the shipped parser first, then the grammar's
 * allow-list. A row that answered an action this grammar does not offer becomes a
 * refusal with `GRAMMAR_GATE_CODE` and keeps its unit; every parse refusal the
 * shipped reader already names is left exactly as it was.
 *
 * `options.lineCounts` is the per-row L the `jsonl-20` reader needs to check a
 * `keeplines` bound; no other grammar reads it.
 */
export function answerRowsOf(text, indices, grammar = DEFAULT_ASK_GRAMMAR, options = {}) {
  const checked = checkGrammar(grammar);
  if (checked === "jsonl-20") {
    // The entry parser normalizes a whole-range keeplines to keepall; the raw
    // line reader below does not. The sim must report what the product reports.
    return parseEntryBatchAnswer(text, indices, "jsonl-20", options.lineCounts);
  }
  if (checked === "jsonl-20-nokeepall") {
    return jsonl20NoKeepallRowsOf(text, indices, options.lineCounts);
  }
  if (checked === "keeplines-60") return keeplines60RowsOf(text, indices);
  const parsed = parseEntryBatchAnswer(text, indices, "3option");
  if (checked === "3option") return parsed;
  const admitted = ADMITTED[checked];
  return parsed.map(row => row.status === "answered" && !admitted.includes(row.answer.action)
    ? Object.freeze({ index: row.index, status: "refused", code: GRAMMAR_GATE_CODE })
    : row);
}

/**
 * Arm B's reading: the shipped reader first (so every shape it can name keeps
 * its own code), then the wider summary cap for the rows IT refused for length,
 * then the action gate. A row answered under the shipped 25-word cap is always
 * inside the 250-word cap, so it is never re-read.
 */
function keeplines60RowsOf(text, indices) {
  const parsed = parseEntryBatchAnswer(text, indices, "3option");
  const readings = wideReadingsOf(text, indices);
  const admitted = ADMITTED["keeplines-60"];
  return parsed.map(row => {
    if (row.status === "answered") {
      return admitted.includes(row.answer.action) ? row : gateRefusal(row.index);
    }
    const reading = readings.get(row.index);
    if (reading === undefined) return row;
    if (!admitted.includes(reading.action)) return gateRefusal(row.index);
    if (descriptorWordCount(reading.summary) > KEEPLINES_60_SUMMARY_WORDS) {
      return Object.freeze({ index: row.index, status: "refused", code: SUMMARY_TOO_LONG_CODE });
    }
    return Object.freeze({ index: row.index, status: "answered", answer: Object.freeze(reading) });
  });
}

/** One row this grammar refuses for its action; it keeps. */
function gateRefusal(index) {
  return Object.freeze({ index, status: "refused", code: GRAMMAR_GATE_CODE });
}

/**
 * Reads one `jsonl-20` answer through CORE's own entry parser
 * (`parseEntryBatchAnswer`, which layers the whole-range keep normalization over
 * `readJsonl20Answer` in `packages/core/src/entry/jsonl-20-answer.ts`). The sim
 * keeps NO copy of the per-line rules, the refusal vocabulary or any action
 * shape, so a product change reaches the sim at once and the two cannot
 * disagree. Core's rows carry their own `message`; the sim's record reads detail
 * through `answerDetailsOf`, so this wrapper returns the two-field row shape the
 * other grammars' readers return.
 *
 * `lineCounts` is still required for a `keeplines` row: its bounds are checked
 * against that row's own L, the count the table showed. A missing count is a
 * caller bug (a `RangeError`), never a silent unchecked range.
 */
export function jsonl20RowsOf(text, indices, lineCounts = new Map()) {
  return readJsonl20Answer(text, indices, lineCounts).rows
    .map(row => row.status === "answered"
      ? { index: row.index, status: "answered", answer: row.answer }
      : { index: row.index, status: "refused", code: row.code });
}

/** The keys a `jsonl-20` answer carried that named no row of this ask. */
export function jsonl20RejectionsOf(text, indices, lineCounts = new Map()) {
  return coreJsonl20RejectionsOf(text, indices, lineCounts);
}

/**
 * `jsonl-20-nokeepall`'s reading: the shipped `jsonl-20` reader first, then the
 * one action this grammar removes. A `keepall` row is answered by the reader
 * (the wire knows it), so it becomes this grammar's `action-not-in-grammar`
 * refusal and the unit keeps. Every other shape — including a `keeplines` over
 * every line, which the reader accepts as a keep — is the shipped reading.
 */
function jsonl20NoKeepallRowsOf(text, indices, lineCounts = new Map()) {
  const admitted = ADMITTED["jsonl-20-nokeepall"];
  return jsonl20RowsOf(text, indices, lineCounts)
    .map(row => row.status === "answered" && !admitted.includes(row.answer.action)
      ? gateRefusal(row.index)
      : row);
}

/** The `jsonl-20` refusal detail, keyed by the row each refusal keeps. */
function jsonl20DetailsOf(text, indices, lineCounts) {
  const readings = readJsonl20Answer(text, indices, lineCounts ?? new Map());
  const details = new Map();
  for (const row of readings.rows) {
    if (row.status !== "refused") continue;
    details.set(row.index, { wireCode: row.code, message: coreJsonl20MessageOf(row.code) });
  }
  return details;
}

/**
 * `jsonl-20-nokeepall`'s detail: the shipped reader's own code and sentence for
 * every parse refusal, and the grammar's sentence for a `keepall` row it
 * answers but does not admit.
 */
function jsonl20NoKeepallDetailsOf(text, indices, lineCounts) {
  const counts = lineCounts ?? new Map();
  const details = jsonl20DetailsOf(text, indices, counts);
  for (const row of jsonl20NoKeepallRowsOf(text, indices, counts)) {
    if (row.status !== "refused" || row.code !== GRAMMAR_GATE_CODE) continue;
    details.set(row.index, {
      wireCode: null, message: gateMessageOf("jsonl-20-nokeepall"),
    });
  }
  return details;
}

/**
 * The rows the SHIPPED reader refused only for summary length, re-read under the
 * arm's 250-word cap. `parsePruneAnswer` is the reading `parseEntryBatchAnswer`
 * wraps, so its `wireCode` names exactly which rows the 25-word cap stopped;
 * only those are reopened, and only when their own shape still reads. A row with
 * any other wire code is never touched here.
 */
function wideReadingsOf(text, indices) {
  const readings = new Map();
  if (typeof text !== "string") return readings;
  let record;
  try { record = JSON.parse(text); } catch { return readings; }
  if (record === null || typeof record !== "object" || Array.isArray(record)) return readings;
  const stamps = stampsOf(indices);
  for (const row of parsePruneAnswer(text, { indices, stamps }).rows) {
    if (row.status !== "refused" || row.wireCode !== SUMMARY_TOO_LONG_CODE) continue;
    const reading = wideReadingOf(record[String(row.index)]);
    if (reading !== null) readings.set(row.index, reading);
  }
  return readings;
}

/**
 * One row's wide reading: the two actions this grammar offers, in the shipped
 * array spelling, and no cap of its own (the caller applies it). A shape that
 * does not read returns null and keeps the shipped refusal.
 */
function wideReadingOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  const action = keys[0];
  const payload = value[action];
  if (action === "forgetall") {
    return typeof payload === "string" ? { action, summary: payload } : null;
  }
  if (action !== "keeplines") return null;
  if (!Array.isArray(payload) || payload.length === 0) return null;
  const summary = payload[payload.length - 1];
  if (typeof summary !== "string") return null;
  const pairs = payload.slice(0, -1);
  if (pairs.length === 0) return null;
  const ranges = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [from, to] = pair;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
    if (from < 1 || to < from) return null;
    ranges.push({ from, to });
  }
  const spans = normalizeKeptSpans(ranges);
  if (spans === null || spans.length === 0) return null;
  return { action, ranges: spans, summary };
}

/** The stamp per index the prune reader demands; identity is the index itself. */
function stampsOf(indices) {
  return new Map(indices.map(index =>
    [index, { unitId: `entry-batch-row:${String(index)}`, answeredInRound: 1 }]));
}

/** Why the row's action is not in this grammar, in one sentence for the record. */
export function gateMessageOf(grammar) {
  const checked = checkGrammar(grammar);
  if (checked === "two-option") {
    return "The answer named lines; this grammar has no line-level option, so the unit is kept.";
  }
  if (checked === "keeplines-60") {
    return "The answer used an action this grammar does not offer; it takes keeplines or"
      + " forgetall, so the unit is kept.";
  }
  if (checked === "jsonl-20") {
    return "The row used an action this grammar does not offer; it keeps.";
  }
  if (checked === "jsonl-20-nokeepall") {
    return "The row used an action this grammar does not offer; it takes forgetall or keeplines,"
      + " so the unit is kept.";
  }
  return "The answer named lines to keep; this grammar names the lines to forget,"
    + " so the unit is kept.";
}

/**
 * The refusal detail `parseEntryBatchAnswer` cannot carry, for one answer under
 * one grammar: the parser's own `wireCode`/`message` for a parse refusal, and the
 * gate's sentence for a row this grammar refuses. Re-reading the same text with
 * `parsePruneAnswer` is deterministic on the same bytes, so the two cannot
 * disagree on which rows refused.
 */
export function answerDetailsOf(text, indices, grammar = DEFAULT_ASK_GRAMMAR, options = {}) {
  const checked = checkGrammar(grammar);
  if (checked === "jsonl-20") return jsonl20DetailsOf(text, indices, options.lineCounts);
  if (checked === "jsonl-20-nokeepall") {
    return jsonl20NoKeepallDetailsOf(text, indices, options.lineCounts);
  }
  if (checked === "keeplines-60") return keeplines60DetailsOf(text, indices);
  const stamps = new Map(indices.map(index =>
    [index, { unitId: `sim-batch-row:${String(index)}`, answeredInRound: 1 }]));
  const details = new Map();
  for (const row of parsePruneAnswer(text, { indices, stamps }).rows) {
    if (row.status !== "refused") continue;
    details.set(row.index, { wireCode: row.wireCode, message: row.message });
  }
  if (checked === "3option") return details;
  for (const row of answerRowsOf(text, indices, checked)) {
    if (row.status !== "refused" || details.has(row.index)) continue;
    details.set(row.index, { wireCode: null, message: gateMessageOf(checked) });
  }
  return details;
}

/**
 * Arm B's refusal detail: the row's final reading decides the slot, so a row
 * this grammar widened to an ANSWER carries no detail at all, a gate refusal
 * carries the gate's sentence, and a summary past the arm's cap carries the
 * arm's own code and message. Every other refusal keeps the shipped parser's
 * own `wireCode`/`message`.
 */
function keeplines60DetailsOf(text, indices) {
  const shipped = new Map();
  for (const row of parsePruneAnswer(text, { indices, stamps: stampsOf(indices) }).rows) {
    if (row.status === "refused") {
      shipped.set(row.index, { wireCode: row.wireCode, message: row.message });
    }
  }
  const details = new Map();
  for (const row of keeplines60RowsOf(text, indices)) {
    if (row.status !== "refused") continue;
    if (row.code === GRAMMAR_GATE_CODE) {
      details.set(row.index, { wireCode: null, message: gateMessageOf("keeplines-60") });
    } else if (row.code === SUMMARY_TOO_LONG_CODE) {
      details.set(row.index, {
        wireCode: SUMMARY_TOO_LONG_CODE,
        message: `The summary runs past ${String(KEEPLINES_60_SUMMARY_WORDS)} words;`
          + " that unit is kept.",
      });
    } else {
      details.set(row.index, shipped.get(row.index) ?? { wireCode: null, message: null });
    }
  }
  return details;
}

/**
 * Why an ANSWERED row cannot be applied as written, or null. `3option` is the
 * shipped `keeplines` arithmetic (`spans-outside-result`, `keeps-every-line`);
 * `two-option` has no ranges, so it always returns null and its one correction
 * turn is unreachable; `forgetlines` checks its named ranges against the row's
 * own line count and refuses a full-range forget (`forgets-all-lines`), the twin
 * of `keeps-every-line`.
 *
 * A reversed span maps to `spans-outside-result` here only if a caller
 * built the answer itself: the wire parser refuses `to < from` as `invalid-span`
 * first, and a parse refusal is never corrected.
 */
export function arithmeticCodeOf(answer, total, grammar = DEFAULT_ASK_GRAMMAR) {
  const checked = checkGrammar(grammar);
  if (checked === "3option") return keeplinesCode(answer, total);
  if (checked === "two-option") return null;
  if (checked === "keeplines-60") return keeplines60Code(answer, total);
  // The jsonl-20 reader checks every range it answers, and an all-lines keep is
  // legal keep-whole, so no answered row can fail arithmetic here. Its
  // `nokeepall` variant reads the same wire and has no arithmetic of its own.
  if (checked === "jsonl-20" || checked === "jsonl-20-nokeepall") return null;
  if (answer?.action !== "forgetlines") return null;
  const ranges = Array.isArray(answer.ranges) ? answer.ranges : [];
  for (const range of ranges) {
    const valid = Number.isSafeInteger(range?.from) && Number.isSafeInteger(range?.to);
    if (!valid || range.from > range.to || range.to > total) return "spans-outside-result";
  }
  const spans = ranges.length === 0 ? null : normalizeKeptSpans(ranges);
  if (spans === null) return null;
  const covered = spans.reduce((sum, span) => sum + (span.to - span.from + 1), 0);
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (covered >= total && first.from === 1 && last.to === total) return "forgets-all-lines";
  return null;
}

/** The shipped `keeplines` arithmetic, unchanged from `entry-ask.ts`'s batch path. */
function keeplinesCode(answer, total) {
  if (answer?.action !== "keeplines") return null;
  const ranges = Array.isArray(answer.ranges) ? answer.ranges : [];
  for (const range of ranges) if (range.to > total) return "spans-outside-result";
  const only = ranges[0];
  if (ranges.length === 1 && only.from === 1 && only.to === total) return "keeps-every-line";
  return null;
}

/**
 * Arm B's arithmetic: the shipped out-of-range check and NOTHING else. Keeping
 * every line is a legal answer here (it is keep-whole, zero bytes leave), so the
 * `keeps-every-line` refusal cannot fire and only a span past the unit's end
 * still earns the one correction turn.
 */
function keeplines60Code(answer, total) {
  if (answer?.action !== "keeplines") return null;
  const ranges = Array.isArray(answer.ranges) ? answer.ranges : [];
  for (const range of ranges) if (range.to > total) return "spans-outside-result";
  return null;
}

/**
 * Whether one answered verdict keeps its unit whole: a `keeplines` whose
 * normalised spans start at line 1, cover every line and end at the last. Such
 * a row removes nothing, so it is counted as a keep and never rendered (no
 * shaped turn, no marker). `forgetall` is never keep-whole; `keepall` always is.
 */
export function keepsWholeOf(answer, total) {
  if (answer === null || answer === undefined) return false;
  if (answer.action === "keepall") return true;
  if (answer.action !== "keeplines") return false;
  if (!Number.isSafeInteger(total) || total < 1) return false;
  const spans = coveredSpansOf(answer);
  if (spans === null) return false;
  const covered = spans.reduce((sum, span) => sum + (span.to - span.from + 1), 0);
  const first = spans[0];
  const last = spans[spans.length - 1];
  return covered >= total && first.from === 1 && last.to === total;
}

/**
 * The lines an answered verdict leaves on the surface, out of `total`. A
 * refused row is passed as `null` and keeps every line, exactly as the parser's
 * refusal rule says. This is the aggregate fidelity gauge the arm records: the
 * 60 percent target is instruction-only and nothing gates on it.
 */
export function keptLineCountOf(answer, total) {
  if (!Number.isSafeInteger(total) || total < 1) return 0;
  if (answer === null || answer === undefined) return total;
  if (answer.action === "keepall") return total;
  if (answer.action === "forgetall") return 0;
  const spans = coveredSpansOf(answer);
  if (spans === null) return total;
  let covered = 0;
  for (const span of spans) {
    covered += Math.max(0, Math.min(span.to, total) - span.from + 1);
  }
  covered = Math.min(covered, total);
  // `forgetlines` names what LEAVES, so its own count is the complement.
  return answer.action === "forgetlines" ? total - covered : covered;
}

/** The normalised spans an answer's ranges name, or null when they read as none. */
function coveredSpansOf(answer) {
  const ranges = Array.isArray(answer?.ranges) ? answer.ranges : [];
  if (ranges.length === 0) return null;
  return normalizeKeptSpans(ranges);
}

/**
 * The batch's ONE correction turn over the rows it names, under one grammar. The
 * `3option` text is today's, byte for byte (its option list is the shipped
 * `keeplines` one); a variant swaps only the option list, so the correction can
 * never teach a shape the arm's own parser refuses. `two-option` never reaches
 * this function — it has no arithmetic refusal — and its text is kept honest
 * anyway.
 */
export function correctionMessageForRows(rows, codes, grammar = DEFAULT_ASK_GRAMMAR) {
  const checked = checkGrammar(grammar);
  const reason = [...codes.entries()].map(([index, code]) => `${String(index)}: ${code}`).join(", ");
  const blocks = rows.filter(row => codes.has(row.index))
    .map(row => `Row ${String(row.index)}: ${factsBlockOf(row, checked)}`).join("\n\n");
  return "Your previous answer could not be applied for row(s) "
    + `${reason}. This turn corrects answers that could not be applied; it does not put the `
    + "keep-or-forget question again.\n"
    + `${blocks}\nAnswer again, once, with exactly one JSON object keyed by the same indices, `
    + `${optionSentence(checked)}\n${ENTRY_ASK_CLOSING_LINE}`;
}

/**
 * The facts block a correction restates: the same one the ask carried, through
 * core's own renderer, so the two cannot drift. `3option` passes no variant and
 * is byte-identical to today; `forgetlines` names its own partial class; and
 * `two-option` states the line count alone, because that arm has no ranges and
 * a correction that mentioned one would teach a shape its parser refuses.
 */
function factsBlockOf(row, grammar) {
  if (grammar === "two-option") {
    return [`This result has ${String(row.lineCount)} lines. Quotes to help you locate them:`,
      ...row.anchorLines].join("\n");
  }
  return entryAskFactsBlock(grammar === "forgetlines" ? { ...row, variant: "forgetlines" } : row);
}

/** The option list one grammar's correction turn teaches. */
function optionSentence(grammar) {
  if (grammar === "two-option") {
    return 'each row one of {"keepall":true} or {"forgetall":"one-line summary"}.'
      + " There is no line-level option.";
  }
  if (grammar === "forgetlines") {
    return 'each row one of {"keepall":true}, {"forgetall":"one-line summary"}, or '
      + '{"forgetlines":[[start,end],"one-line summary"]}. The named lines are removed; every line '
      + "you do not name stays. Ranges are 1-based and inclusive, inside each row's own line count.";
  }
  if (grammar === "keeplines-60") {
    return 'each row one of {"forgetall":"one-line summary"} or '
      + '{"keeplines":[[start,end],"one-line summary"]}. The named lines are kept; the rest is '
      + "replaced by the summary. Ranges are 1-based and inclusive, inside each row's own line"
      + " count.";
  }
  if (grammar === "jsonl-20") {
    return 'one JSON object per line, each keyed by its row index: {"N":{"keepall":true}}, '
      + '{"N":{"forgetall":true,"summary":"one-line summary"}}, or '
      + '{"N":{"keeplines":[[start,end],...],"summary":"one-line summary"}}.';
  }
  if (grammar === "jsonl-20-nokeepall") {
    return 'one JSON object per line, each keyed by its row index: '
      + '{"N":{"forgetall":true,"summary":"one-line summary"}} or '
      + '{"N":{"keeplines":[[start,end],...],"summary":"one-line summary"}}.';
  }
  return 'each row one of {"keepall":true}, {"forgetall":"one-line summary"}, or '
    + '{"keeplines":[[start,end],"one-line summary"]}. Ranges are 1-based and inclusive, inside each '
    + "row's own line count.";
}

/**
 * The rows as `renderPruneAskRows` reads them. `call` rides the `[kind]` slot so
 * a variant row reads exactly as a shipped batch row does — same index, same
 * ordinal convention — and the placeholder unit is never read by the renderer,
 * as in `batch-ask.ts`.
 */
function rendererRowsOf(rows) {
  const counts = new Map();
  return rows.map(row => {
    const ordinal = (counts.get(row.call) ?? 0) + 1;
    counts.set(row.call, ordinal);
    return {
      index: row.index,
      unit: {
        id: `entry-batch-row:${String(row.index)}`,
        nodeId: "",
        source: { nodeId: "", sha256: "", byteLength: 0 },
        path: null,
        span: { byteRange: { startByte: 0, endByteExclusive: 0 }, lineRange: null },
        byteLength: 0,
      },
      anchor: { kind: row.call, callOrdinal: ordinal, anchors: row.anchorLines },
    };
  });
}
