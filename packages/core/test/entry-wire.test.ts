import assert from "node:assert/strict";
import { test } from "node:test";
import {

  ENTRY_ANSWER_ACTIONS, EntryAnswerError, parseEntryAnswer, isKeepEverythingAnswer,
} from "../src/verdicts/entry-wire.js";
import type { EntryAnswerErrorCode } from "../src/verdicts/entry-wire.js";
import { RECEIPT_DESCRIPTOR_WORD_LIMIT } from "../src/verdicts/labels.js";
import { parseWireVerdict, WireVerdictError } from "../src/verdicts/wire.js";

/** One refusal, asserted by code: the stable part a journal and a test quote. */
function refuses(text: string, code: EntryAnswerErrorCode, label = text): EntryAnswerError {
  try {
    parseEntryAnswer(text);
  } catch (error) {
    assert.ok(error instanceof EntryAnswerError, `row: ${label} — expected EntryAnswerError, got ${String(error)}`);
    assert.equal(error.code, code, `row: ${label} — expected ${code}, got ${error.code}`);
    assert.ok(error.message.length > 0, `row: ${label} — a refusal always names its defect`);
    return error;
  }
  assert.fail(`row: ${label} — expected a ${code} refusal`);
}

const words = Array.from({ length: RECEIPT_DESCRIPTOR_WORD_LIMIT }, () => "word");
const atCap = words.join(" ");
const pastCap = `${atCap} overflow`;

/**
 * Every answer the entry lane reads back, one row per case. The `name` is
 * carried into the assertion message so a failure names the case.
 */
const ACCEPTED_ROWS: readonly { name: string; text: string; expect: unknown }[] = [
  {
    name: "keepall is the boolean true under its only key",
    text: '{"keepall":true}',
    expect: { action: "keepall" },
  },
  {
    name: "keeplines pairs plus its trailing summary become ordered kept spans",
    text: '{"keeplines":[[4,5],[1,2],"kept the header"]}',
    expect: {
      action: "keeplines",
      ranges: [{ from: 1, to: 2 }, { from: 4, to: 5 }],
      summary: "kept the header",
    },
  },
  {
    // The mirror of keeplines: the same array shape, the ranges name what LEAVES
    // (ADR-0026 §2–§3), and the summary describes those dropped lines.
    name: "forgetlines pairs plus its trailing summary become ordered dropped spans",
    text: '{"forgetlines":[[4,5],[1,2],"dropped the banner and the tail"]}',
    expect: {
      action: "forgetlines",
      ranges: [{ from: 1, to: 2 }, { from: 4, to: 5 }],
      summary: "dropped the banner and the tail",
    },
  },
  {
    name: "forgetall carries its summary as the value",
    text: '{"forgetall":"a stale build log"}',
    expect: { action: "forgetall", summary: "a stale build log" },
  },
  {
    name: "forgetall carries a blank summary too",
    text: '{"forgetall":""}',
    expect: { action: "forgetall", summary: "" },
  },
  {
    // Same normaliser as keeplines: overlapping and touching pairs merge.
    name: "keeplines merges overlapping and touching pairs",
    text: '{"keeplines":[[1,3],[3,4],[5,6],"s"]}',
    expect: { action: "keeplines", ranges: [{ from: 1, to: 6 }], summary: "s" },
  },
  {
    // Touching pairs merge because the dropped set is identical.
    name: "forgetlines normalises unsorted, overlapping and touching pairs",
    text: '{"forgetlines":[[5,6],[1,3],[3,4],"s"]}',
    expect: { action: "forgetlines", ranges: [{ from: 1, to: 6 }], summary: "s" },
  },
  {
    name: "forgetlines accepts a blank summary",
    text: '{"forgetlines":[[2,3],""]}',
    expect: { action: "forgetlines", ranges: [{ from: 2, to: 3 }], summary: "" },
  },
  {
    // The keeplines pin ADR-0026 §7 asks for: the exact parse keeplines produced
    // before the fourth action existed.
    name: "keeplines keeps its pre-forgetlines parse",
    text: '{"keeplines":[[4,5],[1,2],"kept the header"]}',
    expect: {
      action: "keeplines", ranges: [{ from: 1, to: 2 }, { from: 4, to: 5 }],
      summary: "kept the header",
    },
  },
  {
    name: "keeplines keeps its merged parse and its blank trailer",
    text: '{"keeplines":[[1,2],""]}',
    expect: { action: "keeplines", ranges: [{ from: 1, to: 2 }], summary: "" },
  },
  {
    name: "a trailer exactly at the 25-word cap is accepted and returned verbatim",
    text: `{"keeplines":[[1,2],${JSON.stringify(atCap)}]}`,
    expect: { action: "keeplines", ranges: [{ from: 1, to: 2 }], summary: atCap },
  },
];

test("accepted answers — one row per action and range normalisation", () => {
  for (const row of ACCEPTED_ROWS) {
    assert.deepEqual(parseEntryAnswer(row.text), row.expect, `row: ${row.name}`);
  }
});

/**
 * Every entry-lane refusal, one row per case. `code` is the refusal class the
 * journal quotes; `text` is the bytes that must produce it.
 */
const REFUSAL_ROWS: readonly { name: string; text: string; code: EntryAnswerErrorCode }[] = [
  // Unreadable JSON is a typed refusal, never a thrown SyntaxError.
  { name: "unterminated object", text: '{"keeplines":[[1,2]', code: "malformed-json" },
  { name: "prose instead of JSON", text: "keep three lines", code: "malformed-json" },
  { name: "trailing bytes after the object", text: '{"keepall":true} trailing', code: "malformed-json" },
  // Zero, several or retired identity keys: the action is the only key.
  { name: "no key at all", text: "{}", code: "mixed-keys" },
  {
    name: "two live actions",
    text: '{"keepall":true,"keeplines":[[1,2],"s"]}',
    code: "mixed-keys",
  },
  { name: "retired unitId beside an action", text: '{"keeplines":[[1,2],"s"],"unitId":"u"}',
    code: "mixed-keys" },
  { name: "a stranger beside an action", text: '{"forgetall":"s","extra":1}', code: "mixed-keys" },
  // One live action plus the retired key is still two keys, so it refuses as a
  // mixed answer before the unknown-action arm is reached — the same refusal
  // the gate lane makes for the same bytes.
  { name: "keepall beside a retired keephead", text: '{"keepall":true,"keephead":3}',
    code: "mixed-keys" },
  // ADR-0033 Decision 4: the parser never chooses between two claims about the
  // one summary field, so both spellings at once is the mixed refusal.
  { name: "both summary spellings on keeplines",
    text: '{"keeplines":[[1,3],"trailer"],"summary":"flat"}', code: "mixed-keys" },
  { name: "both summary spellings on forgetlines",
    text: '{"forgetlines":[[1,3],"trailer"],"summary":"flat"}', code: "mixed-keys" },
  {
    name: "two partial classes in one answer",
    text: '{"keeplines":[[1,2]],"summary":"s","forgetlines":[[3,4],"t"]}',
    code: "mixed-keys",
  },
  { name: "keepall beside a sibling summary", text: '{"keepall":true,"summary":"s"}',
    code: "mixed-keys" },
  { name: "forgetall beside a sibling summary", text: '{"forgetall":"s","summary":"t"}',
    code: "mixed-keys" },
  { name: "a partial plus a retired key", text: '{"keeplines":[[1,2]],"summary":"s","unitId":"u"}',
    code: "mixed-keys" },
  { name: "a partial plus a stranger", text: '{"forgetlines":[[1,2]],"summary":"s","extra":1}',
    code: "mixed-keys" },
  // The keeplines refusals ADR-0026 §7 pins: unchanged by the fourth action.
  { name: "empty keeplines array", text: '{"keeplines":[]}', code: "invalid-keeplines" },
  { name: "keeplines as a JSON string", text: '{"keeplines":"[[1,2],\\"s\\"]"}',
    code: "invalid-keeplines" },
  { name: "keeplines as an object", text: '{"keeplines":{"ranges":[[1,2]],"summary":"s"}}',
    code: "invalid-keeplines" },
  { name: "keeplines with no summary", text: '{"keeplines":[[1,2]]}', code: "summary-missing" },
  { name: "keeplines with a non-string trailer", text: '{"keeplines":[[1,2],3]}',
    code: "summary-missing" },
  { name: "keeplines with only a summary", text: '{"keeplines":["only a summary"]}',
    code: "empty-ranges" },
  { name: "a reversed span", text: '{"keeplines":[[3,2],"s"]}', code: "invalid-span" },
  // The summary is still required, still typed, and still capped in either spelling.
  { name: "kept sibling summary absent", text: '{"keeplines":[[1,2]]}', code: "summary-missing" },
  { name: "kept sibling summary not a string", text: '{"keeplines":[[1,2]],"summary":7}',
    code: "summary-missing" },
  { name: "dropped sibling summary absent", text: '{"forgetlines":[[1,2]]}',
    code: "summary-missing" },
  { name: "kept sibling summary past the cap",
    text: `{"keeplines":[[1,2]],"summary":${JSON.stringify(pastCap)}}`, code: "summary-too-long" },
  { name: "dropped sibling summary past the cap",
    text: `{"forgetlines":[[1,2]],"summary":${JSON.stringify(pastCap)}}`, code: "summary-too-long" },
  // A summary past the 25-word cap is refused on either action.
  { name: "kept trailer past the cap", text: `{"keeplines":[[1,2],${JSON.stringify(pastCap)}]}`,
    code: "summary-too-long" },
  { name: "forgetall summary past the cap", text: `{"forgetall":${JSON.stringify(pastCap)}}`,
    code: "summary-too-long" },
];

test("entry refusals — one code per row, and the cap is the owner's 25", () => {
  assert.equal(RECEIPT_DESCRIPTOR_WORD_LIMIT, 25, "the advertised cap is the owner's number");
  for (const row of REFUSAL_ROWS) refuses(row.text, row.code, row.name);
});

test("the four-action vocabulary is closed, and keephead refuses as an unknown action", () => {
  assert.deepEqual([...ENTRY_ANSWER_ACTIONS], ["keepall", "keeplines", "forgetall", "forgetlines"]);
  // ISSUE-058 chunk P2, ADR-0022 §9: a first-N prefix is not an answer class.
  // The key is gone from the vocabulary, so every shape of it takes the normal
  // unknown-action refusal — including the shapes the old fourth arm specialised
  // on (`0`, a fraction, a past-the-end count) rather than a code of their own.
  for (const text of ['{"keephead":3}', '{"keephead":0}', '{"keephead":-1}',
    '{"keephead":1.5}', '{"keephead":"3"}', '{"keephead":true}', '{"keephead":999999}',
    '{"keephead":{"lines":3}}', '{"keephead ":3}']) {
    refuses(text, "unknown-action");
  }
  // Plausible neighbours of the four live actions, one at a time: each is one
  // unknown-action refusal, never silently read as a whole keep or a drop.
  for (const key of ["keephead", "keepfirst", "keeplinesN", "keep", "keepalllines",
    "forget", "drop", "dropall", "keepnone", "keeplast", "keepbytes", "forgetlines2", "cap"]) {
    refuses(JSON.stringify({ [key]: key === "keepalllines" ? true : 3 }), "unknown-action");
  }
  for (const text of ['{"keep":3}', '{"forgetlinesN":[[1,2],"s"]}',
    '{"":3}', '{"forgetall2":"s"}']) {
    refuses(text, "unknown-action");
  }
  const error = refuses('{"keephead":3}', "unknown-action");
  assert.equal(error.message.includes("keephead"), false,
    "the refusal lists the live actions and never the retired one");
  for (const action of ENTRY_ANSWER_ACTIONS) assert.ok(error.message.includes(action), action);
});

test("isKeepEverythingAnswer reads both keep-everything forms, and only the None note", () => {
  const lines = 6;
  const keepall = { action: "keepall" } as const;
  assert.equal(isKeepEverythingAnswer(keepall, lines), true);
  const noneForm = parseEntryAnswer('{"keeplines":[[1,6],"None"]}');
  assert.equal(isKeepEverythingAnswer(noneForm, lines), true);
  // The ranges alone cannot say it: the same full range with a real note is a
  // partial answer that merely names every line.
  const noted = parseEntryAnswer('{"keeplines":[[1,6],"kept it all"]}');
  assert.equal(isKeepEverythingAnswer(noted, lines), false);
  // One line short of the body is a genuine partial, note or not.
  const shortByOne = parseEntryAnswer('{"keeplines":[[1,5],"None"]}');
  assert.equal(isKeepEverythingAnswer(shortByOne, lines), false);
  // Span order is normalised, so an unsorted pair of halves still covers 1..6.
  const unsorted = parseEntryAnswer('{"keeplines":[[4,6],[1,3],"None"]}');
  assert.equal(isKeepEverythingAnswer(unsorted, lines), true);
});

test("a partial class reads its summary from a sibling key as the same answer", () => {
  // ADR-0033: the trailer and the sibling `summary` are one field in two
  // spellings, so both parse to the same object and nothing downstream moves.
  assert.deepEqual(parseEntryAnswer('{"keeplines":[[1,20],[30,40]],"summary":"s"}'),
    parseEntryAnswer('{"keeplines":[[1,20],[30,40],"s"]}'));
  assert.deepEqual(parseEntryAnswer('{"keeplines":[[1,20],[30,40]],"summary":"s"}'), {
    action: "keeplines",
    ranges: [{ from: 1, to: 20 }, { from: 30, to: 40 }],
    summary: "s",
  });
  assert.deepEqual(parseEntryAnswer('{"forgetlines":[[5,6],[1,3]],"summary":"dropped"}'),
    parseEntryAnswer('{"forgetlines":[[5,6],[1,3],"dropped"]}'));
  assert.deepEqual(parseEntryAnswer('{"forgetlines":[[5,6],[1,3]],"summary":"dropped"}'), {
    action: "forgetlines",
    ranges: [{ from: 1, to: 3 }, { from: 5, to: 6 }],
    summary: "dropped",
  });
});

test("duplicate JSON keys are invisible: JSON.parse keeps the last, documented not repaired", () => {
  // N19 fact one. This is already true on the gate lane and stays true here;
  // the tests pin the observed behaviour so a later hand-written scanner cannot
  // change it by accident. `keeplines` twice means the second payload.
  assert.deepEqual(parseEntryAnswer('{"keeplines":[[1,2],"a"],"keeplines":[[3,4],"b"]}'),
    { action: "keeplines", ranges: [{ from: 3, to: 4 }], summary: "b" });
  // A duplicate of one action under two different keys is still one visible
  // key pair, so it refuses; the invisible case is only the same key twice.
  refuses('{"keeplines":[[1,2],"a"],"keepall":true,"keeplines":[[3,4],"b"]}', "mixed-keys");
  refuses('{"keepall":true,"keepall":false}', "invalid-keepall");
});

test("the CRITIC-PINNED boundary: the judge lane refuses keephead as an unknown action", () => {
  // G2. The gate lane's grammar is three actions and never `keephead`; a judge
  // must not shape a landed unit with a key the guard does not check for that
  // rule. The refusal is the gate lane's own class and code.
  try {
    parseWireVerdict({ keephead: 3 }, { unitId: "unit:sha256:abc", answeredInRound: 4 });
  } catch (error) {
    assert.ok(error instanceof WireVerdictError, `expected WireVerdictError, got ${String(error)}`);
    assert.ok(!(error instanceof EntryAnswerError), "the two lanes keep distinct error classes");
    assert.equal(error.code, "unknown-action");
    assert.ok(error.message.includes("keephead") === false,
      "the gate lane's message lists its own three actions only");
    assert.ok(error.message.includes("keepall"));
    assert.ok(error.message.includes("keeplines"));
    assert.ok(error.message.includes("forgetall"));
    return;
  }
  assert.fail("the judge lane parsed keephead");
});

test("both lanes read the same four actions, and keephead is on neither", () => {
  // ADR-0022 §9 and its consequence: the entry lane keeps its own module and
  // error class, but the vocabulary is byte for byte the gate lane's. The
  // gate lane's list is module-private, so its observable form is the refusal
  // code: an action it knows fails on its payload, never as unknown.
  assert.deepEqual([...ENTRY_ANSWER_ACTIONS], ["keepall", "keeplines", "forgetall", "forgetlines"]);
  assert.equal((ENTRY_ANSWER_ACTIONS as readonly string[]).includes("keephead"), false);
  const payloads: readonly (readonly [string, unknown, string])[] = [
    ["keepall", 1, "invalid-keepall"],
    ["keeplines", [[1, 2]], "summary-missing"],
    ["forgetlines", [[1, 2]], "summary-missing"],
    ["forgetall", 7, "invalid-forgetall"],
  ];
  for (const [action, payload, expected] of payloads) {
    try {
      parseWireVerdict({ [action]: payload },
        { unitId: "unit:sha256:abc", answeredInRound: 1 });
      assert.fail(`the gate lane refused nothing for ${action}`);
    } catch (error) {
      assert.ok(error instanceof WireVerdictError, String(error));
      assert.equal(error.code, expected, `${action} is on the gate vocabulary too`);
    }
  }
});

test("the action key is read case- and number-insensitively (ISSUE-515)", () => {
  // The key's spelling folds; the payload is still read from the key the model
  // wrote, and a true misspelling or two action keys still refuse.
  assert.deepEqual(parseEntryAnswer('{"KEEPLINES":[[1,2],"s"]}'),
    { action: "keeplines", ranges: [{ from: 1, to: 2 }], summary: "s" });
  assert.deepEqual(parseEntryAnswer('{"Keepall":true}'), { action: "keepall" });
  assert.deepEqual(parseEntryAnswer('{"FORGETALL":"s"}'),
    { action: "forgetall", summary: "s" });
  assert.deepEqual(parseEntryAnswer('{"forgetline":[[1,2],"s"]}'),
    { action: "forgetlines", ranges: [{ from: 1, to: 2 }], summary: "s" });
  refuses('{"kleplines":[[1,2],"s"]}', "unknown-action");
  refuses('{"keeplines":[[1,2]],"KEEPLINES":[[1,2]],"summary":"s"}', "mixed-keys");
  refuses('{"KEEPLINES":[[1,2],"s"],"summary":"t"}', "mixed-keys");
});

test("forgotten is the canonical partial key and summary its legacy alias (ISSUE-525)", () => {
  const canonical = parseEntryAnswer(
    '{"keeplines":[[1,2]],"forgotten":"the stale log lines"}');
  assert.deepEqual(canonical, {
    action: "keeplines", ranges: [{ from: 1, to: 2 }], summary: "the stale log lines",
  });
  assert.deepEqual(parseEntryAnswer('{"keeplines":[[1,2]],"summary":"the stale log lines"}'),
    canonical, "the legacy key reads as the same answer");
  assert.deepEqual(parseEntryAnswer(
    '{"forgetlines":[[1,2]],"forgotten":"the stale log lines"}'),
  { action: "forgetlines", ranges: [{ from: 1, to: 2 }], summary: "the stale log lines" });
  refuses('{"keeplines":[[1,2]],"forgotten":"a","summary":"b"}',
    "both-forgotten-and-summary", "a row carrying both keys is refused, never merged");
  refuses('{"forgetlines":[[1,2]],"forgotten":"a","summary":"b"}',
    "both-forgotten-and-summary");
  const missing = refuses('{"keeplines":[[1,2]]}', "summary-missing");
  assert.equal(missing.message.includes("forgotten"), true,
    "the summary-missing message names the canonical key");
});
