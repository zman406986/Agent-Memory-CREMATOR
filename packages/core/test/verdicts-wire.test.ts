import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWireVerdict, WireVerdictError } from "../src/verdicts/wire.js";
import type { WireStamp, WireVerdictErrorCode } from "../src/verdicts/wire.js";
import { RECEIPT_DESCRIPTOR_WORD_LIMIT } from "../src/verdicts/labels.js";

const stamp = { unitId: "unit:sha256:abc", answeredInRound: 4 };

/** One refusal, asserted by code: the stable part a retry prompt quotes. */
function refuses(
  value: unknown,
  code: WireVerdictErrorCode,
  row: string,
  box: { readonly stamp: unknown } = { stamp },
): WireVerdictError {
  try {
    // Boxed, not defaulted: an absent stamp must reach the parser as `undefined`,
    // which a default parameter would silently replace.
    parseWireVerdict(value, box.stamp as WireStamp);
  } catch (error) {
    assert.ok(error instanceof WireVerdictError,
      `row: ${row} — expected WireVerdictError, got ${String(error)}`);
    assert.equal(error.code, code, `row: ${row} — expected ${code}, got ${error.code}`);
    assert.ok(error.message.length > 0, `row: ${row} — a refusal always names its defect`);
    return error;
  }
  assert.fail(`row: ${row} — expected a ${code} refusal`);
}

const words = Array.from({ length: RECEIPT_DESCRIPTOR_WORD_LIMIT }, () => "word");
const atCap = words.join(" ");
const pastCap = [...words, "overflow"].join(" ");

interface AcceptedRow {
  readonly name: string;
  readonly value: unknown;
  readonly expect: unknown;
  readonly wireStamp?: WireStamp;
}

/**
 * Every answer the gate lane reads, one row per case: the four actions, the
 * trailer each partial class carries, the normalisation the planner applies,
 * and the cap's boundary.
 */
const ACCEPTED_ROWS: readonly AcceptedRow[] = [
  {
    name: "keepall is the boolean true under its only key",
    value: { keepall: true },
    expect: { verdict: { unitId: "unit:sha256:abc", answeredInRound: 4, action: "keepall" } },
  },
  {
    // ISSUE-515: case and one trailing `s` do not name another action, and the
    // payload is read from the key the model wrote.
    name: "an action key in another case or number is the same action",
    value: { KEEPLINES: [[4, 5], [1, 2], "kept the header"] },
    expect: {
      verdict: {
        unitId: "unit:sha256:abc", answeredInRound: 4, action: "keeplines",
        ranges: [{ from: 1, to: 2 }, { from: 4, to: 5 }],
      },
      keeplinesSummary: "kept the header",
    },
  },
  {
    name: "keeplines pairs plus its trailing summary become ordered kept spans",
    value: { keeplines: [[4, 5], [1, 2], "kept the header and the tail"] },
    expect: {
      verdict: {
        unitId: "unit:sha256:abc", answeredInRound: 4, action: "keeplines",
        ranges: [{ from: 1, to: 2 }, { from: 4, to: 5 }],
      },
      keeplinesSummary: "kept the header and the tail",
    },
  },
  {
    name: "forgetlines is the same shape with the ranges naming the drop",
    value: { forgetlines: [[4, 5], [1, 2], "the dropped lines"] },
    expect: {
      verdict: {
        unitId: "unit:sha256:abc", answeredInRound: 4, action: "forgetlines",
        ranges: [{ from: 1, to: 2 }, { from: 4, to: 5 }],
      },
      forgetlinesSummary: "the dropped lines",
    },
  },
  {
    name: "forgetlines accepts a blank trailer",
    value: { forgetlines: [[2, 3], ""] },
    expect: {
      verdict: {
        unitId: "unit:sha256:abc", answeredInRound: 4, action: "forgetlines",
        ranges: [{ from: 2, to: 3 }],
      },
      forgetlinesSummary: "",
    },
  },
  {
    name: "keeplines merges overlapping and touching pairs, as the planner does",
    value: { keeplines: [[1, 3], [3, 4], [5, 6], "s"] },
    expect: {
      verdict: {
        unitId: "unit:sha256:abc", answeredInRound: 4, action: "keeplines",
        ranges: [{ from: 1, to: 6 }],
      },
      keeplinesSummary: "s",
    },
  },
  {
    name: "a blank keeplines summary is zero words",
    value: { keeplines: [[1, 2], ""] },
    expect: {
      verdict: {
        unitId: "unit:sha256:abc", answeredInRound: 4, action: "keeplines",
        ranges: [{ from: 1, to: 2 }],
      },
      keeplinesSummary: "",
    },
  },
  {
    name: "a blank forgetall summary ships the floor receipt line",
    value: { forgetall: "" },
    expect: { verdict: { unitId: "unit:sha256:abc", answeredInRound: 4, action: "forgetall", summary: "" } },
  },
  {
    name: "a keeplines trailer exactly at the cap is returned verbatim, not dropped",
    value: { keeplines: [[1, 2], atCap] },
    expect: {
      verdict: {
        unitId: "unit:sha256:abc", answeredInRound: 4, action: "keeplines",
        ranges: [{ from: 1, to: 2 }],
      },
      keeplinesSummary: atCap,
    },
  },
  {
    name: "a forgetall summary exactly at the cap is accepted",
    value: { forgetall: atCap },
    expect: { verdict: { unitId: "unit:sha256:abc", answeredInRound: 4, action: "forgetall", summary: atCap } },
  },
  {
    name: "the stamp supplies identity and round, never the answer",
    value: { keepall: true },
    wireStamp: { unitId: "other", answeredInRound: 9 },
    expect: { verdict: { unitId: "other", answeredInRound: 9, action: "keepall" } },
  },
  {
    // ADR-0039: a whole-unit action written bare is the same answer, not a
    // repair. `keepall` takes no argument, so its string form loses nothing.
    name: "a bare keepall string reads as the whole-unit keep",
    value: "keepall",
    expect: { verdict: { unitId: "unit:sha256:abc", answeredInRound: 4, action: "keepall" } },
  },
  {
    // `forgetall`'s only argument is a summary, and a blank summary is already
    // legal (zero words, the floor receipt line), so the bare form is lossless.
    name: "a bare forgetall string reads as the whole-unit drop with no descriptor",
    value: "forgetall",
    expect: {
      verdict: {
        unitId: "unit:sha256:abc", answeredInRound: 4, action: "forgetall", summary: "",
      },
    },
  },
  {
    name: "a bare keepall string inside a batch row is the same answer",
    value: "keepall",
    wireStamp: { unitId: "entry-batch-row:1", answeredInRound: 1 },
    expect: { verdict: { unitId: "entry-batch-row:1", answeredInRound: 1, action: "keepall" } },
  },
];

test("accepted answers — one row per action, trailer and range normalisation", () => {
  for (const row of ACCEPTED_ROWS) {
    assert.deepEqual(parseWireVerdict(row.value, row.wireStamp ?? stamp), row.expect,
      `row: ${row.name}`);
  }
});

interface RefusalRow {
  readonly name: string;
  readonly value: unknown;
  readonly code: WireVerdictErrorCode;
}

/**
 * Every refusal the gate lane makes, one row per case. A code repeated across
 * rows is repeated because a different defect must reach the same verdict: the
 * payload classes, the action vocabulary, and the summary cap each have their
 * own arms.
 */
const REFUSAL_ROWS: readonly RefusalRow[] = [
  // The payload class itself: not an array of pairs plus a trailer.
  { name: "forgetlines empty array", value: { forgetlines: [] }, code: "invalid-forgetlines" },
  { name: "forgetlines as a JSON string", value: { forgetlines: "[[1,2],\"s\"]" },
    code: "invalid-forgetlines" },
  { name: "forgetlines as an object", value: { forgetlines: { ranges: [[1, 2]], summary: "s" } },
    code: "invalid-forgetlines" },
  // The trailer is required, and typed.
  { name: "forgetlines with no summary", value: { forgetlines: [[1, 2]] }, code: "summary-missing" },
  { name: "forgetlines with a non-string trailer", value: { forgetlines: [[1, 2], 3] },
    code: "summary-missing" },
  // A trailer with no pairs names nothing to drop.
  { name: "forgetlines with only a summary", value: { forgetlines: ["only a summary"] },
    code: "empty-ranges" },
  // A span is never repaired: reversed, zero-based, fractional, short, long, unpaired.
  { name: "forgetlines reversed span", value: { forgetlines: [[3, 2], "s"] }, code: "invalid-span" },
  { name: "forgetlines zero-based span", value: { forgetlines: [[0, 2], "s"] }, code: "invalid-span" },
  { name: "forgetlines fractional span", value: { forgetlines: [[1.5, 2], "s"] }, code: "invalid-span" },
  { name: "forgetlines one-element span", value: { forgetlines: [[1], "s"] }, code: "invalid-span" },
  { name: "forgetlines three-element span", value: { forgetlines: [[1, 2, 3], "s"] }, code: "invalid-span" },
  { name: "forgetlines span is not a pair", value: { forgetlines: ["not a pair", "s"] },
    code: "invalid-span" },
  { name: "keeplines reversed span", value: { keeplines: [[3, 2], "s"] }, code: "invalid-span" },
  { name: "keeplines zero-based span", value: { keeplines: [[0, 2], "s"] }, code: "invalid-span" },
  { name: "keeplines fractional span", value: { keeplines: [[1.5, 2], "s"] }, code: "invalid-span" },
  { name: "keeplines one-element span", value: { keeplines: [[1], "s"] }, code: "invalid-span" },
  { name: "keeplines three-element span", value: { keeplines: [[1, 2, 3], "s"] }, code: "invalid-span" },
  { name: "keeplines span is not a pair", value: { keeplines: ["not a pair", "s"] }, code: "invalid-span" },
  // The action vocabulary is closed and never falls through to forgetall. The
  // default arm refuses an action added to the list before its case, and
  // `keephead` is the retired first-N class a gate-lane parser never accepts.
  { name: "action forget", value: { forget: "a summary that would otherwise be read as forgetall" },
    code: "unknown-action" },
  { name: "action keeplines with trailing space",
    value: { "keeplines ": "a summary that would otherwise be read as forgetall" },
    code: "unknown-action" },
  // ISSUE-515: a wrong-case key is the same action, so the payload check is
  // what refuses this row, never the spelling.
  { name: "a case-folded keepall still checks its payload",
    value: { Keepall: "a summary that would otherwise be read as forgetall" },
    code: "invalid-keepall" },
  { name: "action forgetall2", value: { forgetall2: "a summary that would otherwise be read as forgetall" },
    code: "unknown-action" },
  { name: "action forgetlinesN", value: { forgetlinesN: "a summary that would otherwise be read as forgetall" },
    code: "unknown-action" },
  { name: "retired action keephead",
    value: { keephead: "a summary that would otherwise be read as forgetall" },
    code: "unknown-action" },
  { name: "empty action key", value: { "": "s" }, code: "unknown-action" },
  // The cap applies to both spellings a summary travels under.
  { name: "keeplines trailer past the cap", value: { keeplines: [[1, 2], pastCap] },
    code: "summary-too-long" },
  { name: "forgetall summary past the cap", value: { forgetall: pastCap }, code: "summary-too-long" },
  // ADR-0039's boundary: only the two whole-unit actions read bare. A partial
  // action names spans the string does not carry, so it stays refused rather
  // than being guessed — the parser never sees the unit's line count.
  { name: "a bare keeplines string names spans it does not carry", value: "keeplines",
    code: "not-an-object" },
  { name: "a bare forgetlines string names spans it does not carry", value: "forgetlines",
    code: "not-an-object" },
  // An unknown bare string is not a whole-unit action either.
  { name: "an unknown bare string", value: "keephead", code: "not-an-object" },
  { name: "a bare action in the wrong case", value: "Keepall", code: "not-an-object" },
  { name: "an empty bare string", value: "", code: "not-an-object" },
  { name: "a bare action with trailing space", value: "keepall ", code: "not-an-object" },
];

test("refused payloads — one refusal code per row", () => {
  assert.equal(RECEIPT_DESCRIPTOR_WORD_LIMIT, 25, "row: cap — the advertised cap is the owner's 25");
  for (const row of REFUSAL_ROWS) refuses(row.value, row.code, row.name);
});

/**
 * A stamp that is not a stamp at all. Callers catch `WireVerdictError`; a bare
 * property read on a missing stamp would escape that handler and crash the gate
 * instead of re-asking the judge.
 */
const STAMP_ROWS: readonly { readonly name: string; readonly wireStamp: unknown }[] = [
  { name: "a null stamp", wireStamp: null },
  { name: "an undefined stamp", wireStamp: undefined },
  { name: "a string stamp", wireStamp: "stamp" },
  { name: "a number stamp", wireStamp: 7 },
  { name: "a stamp with no unit id", wireStamp: { answeredInRound: 4 } },
  { name: "a stamp with no round", wireStamp: { unitId: "u" } },
  { name: "an empty unit id", wireStamp: { unitId: "", answeredInRound: 0 } },
  { name: "a fractional round", wireStamp: { unitId: "u", answeredInRound: 1.5 } },
];

test("an absent or malformed stamp is a typed refusal, not a TypeError", () => {
  for (const row of STAMP_ROWS) {
    const error = refuses({ keepall: true }, "invalid-stamp", row.name, { stamp: row.wireStamp });
    assert.equal(error.name, "WireVerdictError", `row: ${row.name} — a named error class, not a builtin`);
  }
});

/**
 * ADR-0026 §2–§3: one shape, two polarities. The two partial classes share one
 * array grammar, so a body that is malformed under one key is malformed under
 * the other with the same code, and a body that normalises does so identically.
 */
const PARITY_ROWS: readonly { readonly name: string; readonly body: unknown;
  readonly code: WireVerdictErrorCode }[] = [
  { name: "a pair list with no trailer", body: [[1, 2]], code: "summary-missing" },
  { name: "a non-string trailer", body: [[1, 2], 3], code: "summary-missing" },
  { name: "a trailer with no pairs", body: ["only a summary"], code: "empty-ranges" },
  { name: "a reversed span", body: [[3, 2], "s"], code: "invalid-span" },
  { name: "a zero-based span", body: [[0, 2], "s"], code: "invalid-span" },
  { name: "a fractional span", body: [[1.5, 2], "s"], code: "invalid-span" },
  { name: "a short span", body: [[1], "s"], code: "invalid-span" },
  { name: "a long span", body: [[1, 2, 3], "s"], code: "invalid-span" },
  { name: "a non-pair element", body: ["not a pair", "s"], code: "invalid-span" },
  { name: "a trailer past the cap", body: [[1, 2], pastCap], code: "summary-too-long" },
];

test("the two partial classes share one grammar and one normalisation", () => {
  for (const row of PARITY_ROWS) {
    for (const action of ["keeplines", "forgetlines"]) {
      refuses({ [action]: row.body }, row.code, `${row.name} under ${action}`);
    }
  }
  const kept = parseWireVerdict({ keeplines: [[1, 3], [3, 4], [5, 6], "s"] }, stamp);
  const dropped = parseWireVerdict({ forgetlines: [[1, 3], [3, 4], [5, 6], "s"] }, stamp);
  assert.deepEqual(kept.verdict, {
    unitId: "unit:sha256:abc", answeredInRound: 4, action: "keeplines", ranges: [{ from: 1, to: 6 }],
  }, "row: kept spans merge");
  assert.deepEqual(dropped.verdict, {
    unitId: "unit:sha256:abc", answeredInRound: 4, action: "forgetlines", ranges: [{ from: 1, to: 6 }],
  }, "row: dropped spans merge exactly as kept spans do");
});

test("a partial wire verdict reads forgotten canonically and summary as its alias (ISSUE-525)", () => {
  const canonical = parseWireVerdict(
    { keeplines: [[1, 2]], forgotten: "the stale log lines" }, stamp);
  assert.deepEqual(canonical, {
    verdict: { unitId: "unit:sha256:abc", answeredInRound: 4, action: "keeplines",
      ranges: [{ from: 1, to: 2 }] },
    keeplinesSummary: "the stale log lines",
  });
  assert.deepEqual(parseWireVerdict(
    { keeplines: [[1, 2]], summary: "the stale log lines" }, stamp),
  canonical, "the legacy key reads as the same answer");
  refuses({ keeplines: [[1, 2]], forgotten: "a", summary: "b" },
    "both-forgotten-and-summary", "a row carrying both keys is refused, never merged");
  refuses({ keeplines: [[1, 2], "a"], forgotten: "b" }, "mixed-keys",
    "a trailer beside the canonical key is refused");
  assert.deepEqual(parseWireVerdict(
    { forgetlines: [[1, 2]], forgotten: "the stale log lines" }, stamp).forgetlinesSummary,
  "the stale log lines");
});
