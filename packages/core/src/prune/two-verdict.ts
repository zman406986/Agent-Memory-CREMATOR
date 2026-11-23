/**
 * The two-verdict answer gate (ISSUE-221): the one normalization both the bulk
 * `nokeepall` grammar and the entry `jsonl-20-nokeepall` grammar apply before a
 * parsed answer can reach the apply path.
 *
 * The grammar offers only `forgetall` and `keeplines`, so the gate refuses every
 * other action the wire can carry. Those actions are not the subject of a
 * repair: `keepall` and `forgetlines` are actions this grammar does not offer,
 * so each is a row refusal (`action-not-in-grammar`) and the unit keeps. That
 * action refusal is terminal: it is decided after the ask path read the row, so
 * no re-ask spends a second reply on it. A span refusal is re-askable wherever
 * the lane re-asks other unreadable rows; the gate only names the defect.
 *
 * The action is read case- and plural-insensitively before that gate decides
 * (ISSUE-515): `KEEPLINES` and `keepline` are the one action `keeplines`, and
 * only the canonical spelling leaves the gate. A `keepall` in any spelling is
 * still an action this grammar does not offer.
 *
 * The one shape the gate normalizes is a `keeplines` whose merged spans cover
 * the row's whole `1..L`: it removes nothing, so it becomes a clean `keepall`.
 * Left as a `keeplines` it would reach the apply path as a both-ends plan that
 * keeps every line, which is the one shape that lane refuses.
 *
 * A `keeplines` span outside the row's own `1..L` is refused, never applied.
 * The count `L` is the one the ask showed; a span past it is the same defect
 * the entry lane's `jsonl-20` reader refuses as `spans-outside-result`, and
 * the gate uses that same code so a journal line reads the same in both lanes.
 * Without this check a `[[1,L+1]]` answer would be counted and priced as an
 * answered L2 removal while the engine planner dropped it.
 *
 * The summary is not what decides the plan. A whole-range `keeplines` is a
 * keep-whole whatever its note says; the prompts teach `None` as the spelling,
 * and the gate does not require the model to have copied it.
 *
 * Everything else is returned exactly as parsed: `forgetall` and every partial
 * `keeplines` inside `1..L` are already the grammar's own answers. The apply
 * path is not touched here, and nothing is mutated.
 */

import { normalizeActionKey } from "../verdicts/action-keys.js";
import type { EntryAnswer } from "../verdicts/entry-wire.js";
import { normalizeKeptSpans } from "../verdicts/plan.js";
import type { KeptLineSpan, Verdict } from "../verdicts/types.js";
import type { WireAnswer } from "../verdicts/wire.js";

/**
 * The refusal code an action outside the grammar earns. It is the product's own
 * gate code (`entry/batch-ask.ts`), repeated here so this prune module keeps no
 * dependency on the entry lane.
 */
export const TWO_VERDICT_GATE_CODE = "action-not-in-grammar";

/** The one sentence a grammar gate refusal carries. */
export const TWO_VERDICT_GATE_MESSAGE =
  "The answer used an action this grammar does not offer; it takes forgetall or"
  + " keeplines, so the unit is kept.";

/**
 * The refusal code a `keeplines` span outside the row's own `1..L` earns. It is
 * the entry `jsonl-20` reader's code, verbatim, so one journal vocabulary names
 * the same defect on both lanes.
 */
export const SPANS_OUTSIDE_RESULT_CODE = "spans-outside-result";

/** The one sentence an out-of-range span refusal carries. */
export const SPANS_OUTSIDE_RESULT_MESSAGE =
  "The keeplines answer named a line outside that row's own 1..L; the row is"
  + " kept.";

/** Every refusal the gate can produce, as data. */
export type TwoVerdictRefusalCode =
  | typeof TWO_VERDICT_GATE_CODE
  | typeof SPANS_OUTSIDE_RESULT_CODE;

/** One normalized entry answer: the verdict to apply, or the refusal that keeps it. */
export type TwoVerdictAnswer =
  | { readonly status: "answered"; readonly answer: EntryAnswer }
  | {
      readonly status: "refused";
      readonly code: TwoVerdictRefusalCode;
      readonly message: string;
    };

/** One normalized wire answer: the verdict to apply, or the refusal that keeps it. */
export type WireTwoVerdictAnswer =
  | { readonly status: "answered"; readonly answer: WireAnswer }
  | {
      readonly status: "refused";
      readonly code: TwoVerdictRefusalCode;
      readonly message: string;
    };

/**
 * Normalizes one parsed entry answer under a two-verdict grammar. `lineCount`
 * is the row's own `L`, the count the ask's table showed; a missing or invalid
 * count is a caller bug, never a guessed total.
 *
 * A whole-range `keeplines` is a keep-whole whatever its summary says: the
 * spans remove nothing, so the note is not what decides the plan. The prompt's
 * `None` is the taught spelling, not a condition of the gate. A span outside
 * `1..lineCount` is refused `spans-outside-result`.
 */
export function normalizeTwoVerdictAnswer(
  answer: EntryAnswer,
  lineCount: number,
): TwoVerdictAnswer {
  checkedLineCount(lineCount);
  const canonical = canonicalEntryAnswer(answer);
  if (canonical.action !== "forgetall" && canonical.action !== "keeplines") {
    return refusal(TWO_VERDICT_GATE_CODE, TWO_VERDICT_GATE_MESSAGE);
  }
  if (canonical.action === "keeplines" && spansOutsideResult(canonical.ranges, lineCount)) {
    return refusal(SPANS_OUTSIDE_RESULT_CODE, SPANS_OUTSIDE_RESULT_MESSAGE);
  }
  if (canonical.action === "keeplines" && coversWholeResult(canonical.ranges, lineCount)) {
    return { status: "answered", answer: { action: "keepall" } };
  }
  return { status: "answered", answer: canonical };
}

/**
 * Normalizes one parsed WIRE answer under the bulk two-verdict grammar. The
 * unit's own `L` comes from its line span; `null` is a zero-line unit, whose
 * `L` is `0`, so no span lies inside `1..L` and every `keeplines` on it is
 * refused `spans-outside-result` (the action gate still applies).
 *
 * A `keeplines` span outside `1..L` is refused; a whole-range `keeplines`
 * becomes a clean `keepall` carrying the same unit id and round, and drops the
 * summary: a keep has no trailer. Every other grammar action crosses unchanged.
 */
export function normalizeWireTwoVerdictAnswer(
  answer: WireAnswer,
  lineCount: number | null,
): WireTwoVerdictAnswer {
  if (lineCount !== null) checkedLineCount(lineCount);
  const canonical = canonicalWireAnswer(answer);
  const verdict = canonical.verdict;
  if (verdict.action !== "forgetall" && verdict.action !== "keeplines") {
    return refusal(TWO_VERDICT_GATE_CODE, TWO_VERDICT_GATE_MESSAGE);
  }
  if (verdict.action === "keeplines" && spansOutsideResult(verdict.ranges, lineCount ?? 0)) {
    return refusal(SPANS_OUTSIDE_RESULT_CODE, SPANS_OUTSIDE_RESULT_MESSAGE);
  }
  if (verdict.action === "keeplines" && lineCount !== null
    && coversWholeResult(verdict.ranges, lineCount)) {
    return {
      status: "answered",
      answer: {
        verdict: {
          unitId: verdict.unitId,
          answeredInRound: verdict.answeredInRound,
          action: "keepall",
        },
      },
    };
  }
  return { status: "answered", answer: canonical };
}

/**
 * The same answer with its action key in canonical spelling (ISSUE-515). The
 * gate reads the action case- and plural-insensitively; the shape it returns is
 * the canonical one, so nothing downstream sees `KEEPLINES` as an action.
 */
function canonicalEntryAnswer(answer: EntryAnswer): EntryAnswer {
  const action = normalizeActionKey(answer.action);
  if (action === null || action === answer.action) return answer;
  return { ...answer, action } as EntryAnswer;
}

/** The wire reading of `canonicalEntryAnswer`: the same leniency, same output shape. */
function canonicalWireAnswer(answer: WireAnswer): WireAnswer {
  const action = normalizeActionKey(answer.verdict.action);
  if (action === null || action === answer.verdict.action) return answer;
  return { ...answer, verdict: { ...answer.verdict, action } as Verdict };
}

/** The one refusal shape, so both normalizers answer with the same sentence per code. */
function refusal(code: TwoVerdictRefusalCode, message: string): {
  readonly status: "refused";
  readonly code: TwoVerdictRefusalCode;
  readonly message: string;
} {
  return { status: "refused", code, message };
}

/** Whether any named span lies outside the row's own `1..lineCount`. */
function spansOutsideResult(
  ranges: readonly KeptLineSpan[],
  lineCount: number,
): boolean {
  return ranges.some(span => span.from < 1 || span.to > lineCount);
}

/** A row's own positive line count, or a caller bug. */
function checkedLineCount(lineCount: number): void {
  if (!Number.isSafeInteger(lineCount) || lineCount < 1) {
    throw new RangeError("a two-verdict normalization needs a positive safe integer line count.");
  }
}

/**
 * Whether the merged kept spans are exactly `1..lineCount`. Touching or
 * overlapping pairs merge first, so `[[1,4],[5,10]]` on a ten-line row counts as
 * the whole range; a gap anywhere means it does not.
 */
function coversWholeResult(ranges: readonly KeptLineSpan[], lineCount: number): boolean {
  const merged = normalizeKeptSpans(ranges);
  if (merged === null || merged.length !== 1) return false;
  const only = merged[0];
  return only !== undefined && only.from === 1 && only.to === lineCount;
}
