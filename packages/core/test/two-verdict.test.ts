import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeTwoVerdictAnswer, normalizeWireTwoVerdictAnswer,
  SPANS_OUTSIDE_RESULT_CODE, SPANS_OUTSIDE_RESULT_MESSAGE,
  TWO_VERDICT_GATE_CODE, TWO_VERDICT_GATE_MESSAGE,
} from "../src/prune/two-verdict.js";
import type { UnitId } from "../src/types/identity.js";
import type { EntryAnswer } from "../src/verdicts/entry-wire.js";
import type { KeptLineSpan } from "../src/verdicts/types.js";
import type { WireAnswer } from "../src/verdicts/wire.js";

/**
 * The two-verdict gate (ISSUE-221): one normalizer for the entry lane's parsed
 * `EntryAnswer`, one for the bulk lane's parsed `WireAnswer`. Both refuse every
 * action the grammar does not offer and turn a whole-range `keeplines` into a
 * clean `keepall`, whatever the summary says.
 */

const UNIT = "unit:sha256:two-verdict" as UnitId;

function wire(ranges: readonly KeptLineSpan[], summary?: string): WireAnswer {
  return {
    verdict: { unitId: UNIT, answeredInRound: 7, action: "keeplines", ranges },
    ...(summary === undefined ? {} : { keeplinesSummary: summary }),
  };
}

function entry(ranges: readonly KeptLineSpan[], summary = "None"): EntryAnswer {
  return { action: "keeplines", ranges, summary };
}

function isRefused(
  outcome: ReturnType<typeof normalizeWireTwoVerdictAnswer>,
): outcome is ReturnType<typeof normalizeWireTwoVerdictAnswer> & { status: "refused" } {
  return outcome.status === "refused";
}

test("the entry gate refuses actions the grammar does not offer and keeps the row", () => {
  for (const answer of [
    { action: "keepall" } as const,
    { action: "forgetlines", ranges: [{ from: 2, to: 3 }], summary: "old" } as const,
  ]) {
    const outcome = normalizeTwoVerdictAnswer(answer, 10);
    assert.equal(outcome.status, "refused", answer.action);
    assert.ok(outcome.status === "refused");
    assert.equal(outcome.code, TWO_VERDICT_GATE_CODE);
    assert.equal(outcome.message, TWO_VERDICT_GATE_MESSAGE);
  }
});

test("the entry gate turns any whole-range keeplines into keepall and leaves the rest alone", () => {
  for (const ranges of [
    [{ from: 1, to: 10 }],
    [{ from: 1, to: 4 }, { from: 5, to: 10 }],
    [{ from: 5, to: 10 }, { from: 1, to: 4 }],
  ]) {
    // The note is the taught spelling, not a condition: a different string
    // still means the whole row was kept.
    assert.deepEqual(normalizeTwoVerdictAnswer(entry(ranges, "a different note"), 10),
      { status: "answered", answer: { action: "keepall" } }, JSON.stringify(ranges));
  }
  const partial = entry([{ from: 1, to: 9 }], "cut one");
  assert.deepEqual(normalizeTwoVerdictAnswer(partial, 10),
    { status: "answered", answer: partial });
  const gapped = entry([{ from: 1, to: 4 }, { from: 6, to: 10 }], "gap");
  assert.deepEqual(normalizeTwoVerdictAnswer(gapped, 10),
    { status: "answered", answer: gapped });
  const forgetall = { action: "forgetall", summary: "old log" } as const;
  assert.deepEqual(normalizeTwoVerdictAnswer(forgetall, 10),
    { status: "answered", answer: forgetall });
  // L is the row's own: the same ranges on a longer row are a partial keep.
  assert.deepEqual(normalizeTwoVerdictAnswer(entry([{ from: 1, to: 10 }]), 11),
    { status: "answered", answer: entry([{ from: 1, to: 10 }]) });
  for (const lineCount of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => normalizeTwoVerdictAnswer(entry([{ from: 1, to: 1 }]), lineCount),
      RangeError);
  }
});

test("the wire gate refuses every action outside forgetall/keeplines", () => {
  const keepall: WireAnswer = {
    verdict: { unitId: UNIT, answeredInRound: 7, action: "keepall" },
  };
  const forgetlines: WireAnswer = {
    verdict: { unitId: UNIT, answeredInRound: 7, action: "forgetlines",
      ranges: [{ from: 2, to: 3 }] },
    forgetlinesSummary: "old",
  };
  for (const answer of [keepall, forgetlines]) {
    const outcome = normalizeWireTwoVerdictAnswer(answer, 10);
    assert.equal(outcome.status, "refused", answer.verdict.action);
    assert.ok(outcome.status === "refused");
    assert.equal(outcome.code, TWO_VERDICT_GATE_CODE);
  }
});

test("the wire gate turns a whole-range keeplines into keepall and keeps the stamp", () => {
  for (const ranges of [
    [{ from: 1, to: 10 }],
    [{ from: 1, to: 4 }, { from: 5, to: 10 }],
  ]) {
    const outcome = normalizeWireTwoVerdictAnswer(wire(ranges, "a different note"), 10);
    assert.deepEqual(outcome, {
      status: "answered",
      answer: { verdict: { unitId: UNIT, answeredInRound: 7, action: "keepall" } },
    }, JSON.stringify(ranges));
  }
  // Partial and gapped spans cross unchanged.
  for (const ranges of [
    [{ from: 1, to: 9 }],
    [{ from: 1, to: 4 }, { from: 6, to: 10 }],
  ]) {
    const answer = wire(ranges, "kept");
    assert.deepEqual(normalizeWireTwoVerdictAnswer(answer, 10),
      { status: "answered", answer });
  }
  // L is the row's own. A fixed 120 is not a universal whole range.
  assert.deepEqual(normalizeWireTwoVerdictAnswer(wire([{ from: 1, to: 50 }]), 50), {
    status: "answered",
    answer: { verdict: { unitId: UNIT, answeredInRound: 7, action: "keepall" } },
  });
  const past = wire([{ from: 1, to: 120 }], "None");
  assert.deepEqual(normalizeWireTwoVerdictAnswer(past, 50),
    { status: "refused", code: SPANS_OUTSIDE_RESULT_CODE,
      message: SPANS_OUTSIDE_RESULT_MESSAGE },
    "120 is outside a 50-line unit, so it is not a whole-range keep");
});

test("both gates refuse a span outside the row's own 1..L as spans-outside-result", () => {
  // The defect: `[[1,L+1]]` arrived as an answered L2 removal while the engine
  // planner dropped it. The gate now refuses it under the entry lane's code.
  for (const ranges of [
    [{ from: 1, to: 11 }],
    [{ from: 11, to: 12 }],
    [{ from: 0, to: 3 }],
    [{ from: 1, to: 9 }, { from: 11, to: 11 }],
  ]) {
    const answer = wire(ranges, "cut");
    assert.deepEqual(normalizeWireTwoVerdictAnswer(answer, 10), {
      status: "refused", code: SPANS_OUTSIDE_RESULT_CODE,
      message: SPANS_OUTSIDE_RESULT_MESSAGE,
    }, JSON.stringify(ranges));
  }
  // The entry gate applies the same rule against its own count.
  assert.deepEqual(normalizeTwoVerdictAnswer(entry([{ from: 1, to: 11 }], "cut"), 10), {
    status: "refused", code: SPANS_OUTSIDE_RESULT_CODE,
    message: SPANS_OUTSIDE_RESULT_MESSAGE,
  });
  assert.deepEqual(normalizeTwoVerdictAnswer({
    action: "keeplines", ranges: [{ from: 0, to: 3 }], summary: "cut",
  }, 10), {
    status: "refused", code: SPANS_OUTSIDE_RESULT_CODE,
    message: SPANS_OUTSIDE_RESULT_MESSAGE,
  });
  // A valid partial is unchanged, and a full range is still the keep-whole.
  const partial = wire([{ from: 1, to: 9 }], "cut");
  assert.deepEqual(normalizeWireTwoVerdictAnswer(partial, 10),
    { status: "answered", answer: partial });
  assert.deepEqual(normalizeWireTwoVerdictAnswer(wire([{ from: 1, to: 10 }], "None"), 10), {
    status: "answered",
    answer: { verdict: { unitId: UNIT, answeredInRound: 7, action: "keepall" } },
  });
});

test("the wire gate refuses every keeplines on a zero-line unit", () => {
  const answer = wire([{ from: 1, to: 1 }], "None");
  assert.deepEqual(normalizeWireTwoVerdictAnswer(answer, null),
    { status: "refused", code: SPANS_OUTSIDE_RESULT_CODE,
      message: SPANS_OUTSIDE_RESULT_MESSAGE },
    "1..0 holds no line, so any named span is outside it");
  assert.equal(isRefused(normalizeWireTwoVerdictAnswer({
    verdict: { unitId: UNIT, answeredInRound: 7, action: "keepall" },
  }, null)), true, "the action gate still applies");
  assert.throws(() => normalizeWireTwoVerdictAnswer(answer, 0), RangeError);
});

test("both gates fold a raw action spelling before they decide (ISSUE-515)", () => {
  // A caller that hands the gate a non-canonical action gets the canonical one
  // back, so nothing downstream sees `KEEPLINES` as an action.
  const rawEntry = {
    action: "KEEPLINES", ranges: [{ from: 1, to: 4 }], summary: "cut",
  } as unknown as EntryAnswer;
  assert.deepEqual(normalizeTwoVerdictAnswer(rawEntry, 10), {
    status: "answered",
    answer: { action: "keeplines", ranges: [{ from: 1, to: 4 }], summary: "cut" },
  });
  const rawWire = {
    verdict: { unitId: UNIT, answeredInRound: 7, action: "FORGETALL", summary: "old" },
  } as unknown as WireAnswer;
  assert.deepEqual(normalizeWireTwoVerdictAnswer(rawWire, 10), {
    status: "answered",
    answer: { verdict: { unitId: UNIT, answeredInRound: 7, action: "forgetall",
      summary: "old" } },
  });
  // A `keepall` in any spelling is still an action this grammar does not offer.
  assert.equal(normalizeTwoVerdictAnswer(
    { action: "KEEPALL" } as unknown as EntryAnswer, 10).status, "refused");
});
