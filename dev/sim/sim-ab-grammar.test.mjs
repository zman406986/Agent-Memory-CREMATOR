#!/usr/bin/env node
/**
 * ISSUE-221: the `jsonl-20-nokeepall` grammar and the ask-grammar A/B lane.
 *
 * Run: `node --test dev/sim/sim-ab-grammar.test.mjs`
 *
 * The grammar cases are pure: prompt bytes, the whole-range example, the
 * `keepall` gate and the full-range keep. The last case runs the A/B wrapper's
 * own `runAbMain` over a synthetic transcript with the stub transport, so both
 * arms go through the live lane's real path with no socket and no key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ENTRY_ASK_END_ANCHOR } from "@cremator/core";
import {
  ASK_GRAMMAR_PROMPTS, GRAMMAR_GATE_CODE, JSONL_20_SUMMARY_WORDS,
  JSONL_20_FIRST_TARGET, JSONL_20_LATER_TARGET, JSONL_20_NOKEEPALL_FIRST_TARGET,
  JSONL_20_NOKEEPALL_LATER_TARGET, JSONL_20_NOKEEPALL_VARIANTS, JSONL_20_SLOT,
  answerDetailsOf, answerRowsOf, arithmeticCodeOf, instructionOf, keptLineCountOf, keepsWholeOf,
} from "./sim-batch-grammar.mjs";
import { askMessageFor } from "./sim-batch-units.mjs";
import {
  AB_GRAMMARS, AB_SCHEMA, AB_STATEMENT, abReportOf, runAbMain,
} from "./sim-ab-grammar.mjs";

const GRAMMAR = "jsonl-20-nokeepall";
const KEEP_ALL_EXAMPLE = '{"N":{"keeplines":[[1,120]],"forgotten":"None"}}';
const DROPPED_SENTENCE = " You can keep some units whole and forget others whole if that meets it.";

/** One unit with a two-line ASCII body, the shape the table renders. */
const unitOf = (seq, lines = 2) => ({
  id: `result:${seq}`, seq, step: 1, bytes: 2000, isError: false, surfaceOp: "append",
  text: Array.from({ length: lines },
    (_, at) => `line ${String(at + 1)} ends with "value-${String(at + 1)}-token"`).join("\n"),
});

/** One rule's line, by its number, from a prompt. */
const ruleOf = (prompt, number) =>
  prompt.split("\n").find(line => line.startsWith(`${String(number)}. `));

test("jsonl-20-nokeepall teaches only keeplines and forgetall, and drops the share sentence",
  () => {
    const prompt = instructionOf(GRAMMAR);
    assert.equal(prompt, ASK_GRAMMAR_PROMPTS[GRAMMAR], "the table names the same bytes");
    assert.ok(!prompt.includes("keepall"), "no keepall action key is taught");
    assert.ok(!prompt.includes("keep some units whole and forget others whole"),
      "the keep-whole share sentence is gone");
    assert.ok(prompt.includes("less than 20 words"), "the summary cap is unchanged");
    assert.ok(prompt.endsWith(`${JSONL_20_NOKEEPALL_FIRST_TARGET}\n\n${JSONL_20_SLOT}`),
      "the share line still sits right before the table slot");

    // Every other rule is jsonl-20's, byte for byte.
    const shipped = instructionOf("jsonl-20");
    for (const number of [1, 4, 5, 6, 7, 8]) {
      assert.equal(ruleOf(prompt, number), ruleOf(shipped, number),
        `rule ${String(number)} is unchanged`);
    }
    assert.ok(!ruleOf(prompt, 2).includes("keepall"), "rule 2 names only the two actions");
    assert.ok(!ruleOf(prompt, 3).includes("keepall"), "rule 3 carries no keepall clause");
    assert.match(ruleOf(prompt, 2), /forgetall.*keeplines/u);
    assert.match(ruleOf(prompt, 3), /forgetall and keeplines/u);

    // Both fire variants: the sentence is gone from both halves, and the
    // variant's own share line appears once in each half.
    for (const [name, target] of [
      ["first", JSONL_20_NOKEEPALL_FIRST_TARGET],
      ["later", JSONL_20_NOKEEPALL_LATER_TARGET],
    ]) {
      const variant = JSONL_20_NOKEEPALL_VARIANTS[name];
      for (const half of [variant.prompt, variant.repeat]) {
        assert.ok(!half.includes("keepall"), `${name}: no keepall in either half`);
        assert.ok(!half.includes("keep some units whole and forget others whole"),
          `${name}: no keep-whole sentence in either half`);
        assert.equal(half.split(target).length - 1, 1, `${name}: its own share line, once`);
      }
      assert.ok(variant.repeat.endsWith(ENTRY_ASK_END_ANCHOR),
        `${name}: the closing anchor is last`);
    }

    // The share lines are jsonl-20's minus exactly the one sentence.
    assert.equal(JSONL_20_NOKEEPALL_FIRST_TARGET,
      JSONL_20_FIRST_TARGET.replace(DROPPED_SENTENCE, ""));
    assert.equal(JSONL_20_NOKEEPALL_LATER_TARGET,
      JSONL_20_LATER_TARGET.replace(DROPPED_SENTENCE, ""));
    assert.ok(!JSONL_20_NOKEEPALL_FIRST_TARGET.includes("keep some units"));
    assert.match(JSONL_20_NOKEEPALL_FIRST_TARGET, /keep at most 70 percent/u);
    assert.match(JSONL_20_NOKEEPALL_LATER_TARGET, /keep at most 40 percent/u);
  });

test("the keep-everything example is a whole-range keeplines and parses", () => {
  const prompt = instructionOf(GRAMMAR);
  assert.equal(prompt.split(KEEP_ALL_EXAMPLE).length - 1, 1,
    "the keep-everything format line appears once");
  const example = JSON.parse(KEEP_ALL_EXAMPLE);
  assert.deepEqual(Object.keys(example.N), ["keeplines", "forgotten"],
    "one action key and its forgotten value");
  assert.deepEqual(example.N.keeplines, [[1, 120]], "[1,120] is the whole range");
  assert.equal(example.N.forgotten, "None");
  assert.ok(prompt.includes('{"1":{"keeplines":[[1,120]],"forgotten":"None"}}'),
    "the answer example carries the same shape, keyed by row 1");
  const ask = askMessageFor([unitOf(1)], new Map(), GRAMMAR);
  assert.ok(ask.includes(KEEP_ALL_EXAMPLE), "the rendered ask carries the example");
  assert.ok(ask.endsWith(ENTRY_ASK_END_ANCHOR), "the rendered ask ends on the anchor");
});

test("a keepall row is refused action-not-in-grammar; the other shapes answer", () => {
  const text = '{"1":{"keepall":true}}\n{"2":{"forgetall":true,"summary":"old log"}}\n'
    + '{"3":{"keeplines":[[2,3]],"summary":"two lines"}}';
  const rows = answerRowsOf(text, [1, 2, 3], GRAMMAR, {
    lineCounts: new Map([[1, 4], [2, 4], [3, 4]]),
  });
  assert.deepEqual(rows.map(row => row.status), ["refused", "answered", "answered"]);
  assert.equal(rows[0].code, GRAMMAR_GATE_CODE, "keepall is not in this grammar");
  assert.equal(rows[1].answer.action, "forgetall");
  assert.equal(rows[2].answer.action, "keeplines");
  // The same bytes under jsonl-20 answer keepall: the gate is the grammar's.
  const shipped = answerRowsOf('{"1":{"keepall":true}}', [1], "jsonl-20");
  assert.equal(shipped[0].answer.action, "keepall");
  // The gate's sentence names the two admitted actions, and it is a gate
  // refusal (no wire code), never a parse code.
  const detail = answerDetailsOf('{"1":{"keepall":true}}', [1], GRAMMAR).get(1);
  assert.equal(detail.wireCode, null);
  assert.match(detail.message, /forgetall or keeplines/u);
  assert.match(detail.message, /kept/u);
});

test("a keeplines naming every line is accepted as keep-all", () => {
  const whole = answerRowsOf('{"1":{"keeplines":[[1,4]],"summary":"the whole unit"}}', [1],
    GRAMMAR, { lineCounts: new Map([[1, 4]]) });
  assert.equal(whole[0].status, "answered", "the old keeps-every-line refusal is not here");
  assert.deepEqual(whole[0].answer.ranges, [{ from: 1, to: 4 }]);
  assert.equal(arithmeticCodeOf(whole[0].answer, 4, GRAMMAR), null);
  assert.equal(keepsWholeOf(whole[0].answer, 4), true, "it removes nothing");
  assert.equal(keptLineCountOf(whole[0].answer, 4), 4);
  // Touching spans that cover the body are the same keep-whole.
  const touching = answerRowsOf('{"1":{"keeplines":[[1,2],[3,4]],"summary":"all of it"}}', [1],
    GRAMMAR, { lineCounts: new Map([[1, 4]]) });
  assert.equal(keepsWholeOf(touching[0].answer, 4), true, "touching spans merge to the whole");
  // A partial keep is a real forget; a bound past L is the shipped refusal.
  const partial = answerRowsOf('{"1":{"keeplines":[[1,2]],"summary":"first two"}}', [1],
    GRAMMAR, { lineCounts: new Map([[1, 4]]) });
  assert.equal(keepsWholeOf(partial[0].answer, 4), false);
  assert.equal(keptLineCountOf(partial[0].answer, 4), 2);
  const past = answerRowsOf('{"1":{"keeplines":[[1,9]],"summary":"too far"}}', [1],
    GRAMMAR, { lineCounts: new Map([[1, 4]]) });
  assert.equal(past[0].status, "refused");
  assert.equal(past[0].code, "spans-outside-result");
  // The summary cap is jsonl-20's: 30 words tolerated, 31 refused.
  assert.equal(JSONL_20_SUMMARY_WORDS, 30);
  const words = count => Array.from({ length: count }, (_, at) => `w${String(at)}`).join(" ");
  const tooLong = answerRowsOf(JSON.stringify({
    1: { forgetall: true, summary: words(JSONL_20_SUMMARY_WORDS + 1) },
  }), [1], GRAMMAR);
  assert.equal(tooLong[0].status, "refused");
  assert.equal(tooLong[0].code, "summary-too-long");
});

test("the A/B report names both arms and the same input count", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "racoons-ab-grammar-"));
  try {
    const transcript = path.join(dir, "session.v4.jsonl");
    const usage = path.join(dir, "result.json");
    const rows = [{ type: "session", version: 4, id: "session-ab" },
      { type: "step/start", seq: 1, data: { step: 1 } }];
    for (let seq = 2; seq <= 5; seq += 1) {
      rows.push({ type: "tool/result", seq, surfaceOp: "append",
        data: { step: 1, message: { role: "tool",
          content: [{ type: "text", text: unitOf(seq, 4).text }] } } });
    }
    writeFileSync(transcript, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
    writeFileSync(usage, JSON.stringify({ rows: [{ step: 1, inputTokens: 1_000,
      cacheReadTokens: 0, outputTokens: 10, totalTokens: 1_010 }] }));
    const out = path.join(dir, "ab");
    const code = await runAbMain(["--i-am-the-owner", "--transport", "stub",
      "--ignore-host-prunes", "--allow-zero-reasoning", "--floor", "100", "--lanes", "2",
      "--ask-ceiling", "2", "--token-grant", "10000000",
      "--transcript", transcript, "--usage", usage, "--out", out]);
    const report = JSON.parse(readFileSync(path.join(out, "ab-grammar.json"), "utf8"));
    assert.equal(code, 0, `the A/B lane exited ${String(code)}: ${JSON.stringify(report.diff)}`);
    assert.equal(report.schema, AB_SCHEMA);
    assert.equal(report.statement, AB_STATEMENT);
    assert.match(report.statement, /only the ask grammar differs/u);
    assert.deepEqual(report.grammars, [...AB_GRAMMARS]);
    assert.deepEqual(report.arms.map(arm => arm.grammar), [...AB_GRAMMARS],
      "the report names both arms");
    assert.equal(report.sameInputCount, true, "both arms read one input");
    assert.equal(report.inputCount, 4, "the four eligible units are the shared input");
    assert.deepEqual(report.arms.map(arm => arm.inputCount), [4, 4]);
    assert.equal(report.onlyGrammarDiffers, true);
    // Both arms decided rows; the answer mix is the one thing that moves.
    for (const arm of report.arms) {
      assert.ok(arm.decisions.keep + arm.decisions.forget > 0, `${arm.grammar} decided rows`);
      assert.ok(arm.askBytes.askText > 0, `${arm.grammar} sent ask bytes`);
      assert.ok(arm.bytes.eligible > 0, `${arm.grammar} states its eligible bytes`);
      assert.equal(arm.bytes.kept, arm.bytes.eligible - arm.bytes.freedNet,
        `${arm.grammar}: kept = eligible - freed`);
    }
    const shipped = report.arms.find(arm => arm.grammar === "jsonl-20");
    const variant = report.arms.find(arm => arm.grammar === "jsonl-20-nokeepall");
    assert.ok(shipped.answerMix.keepall > 0, "jsonl-20 answers keepall");
    assert.equal(variant.answerMix.keepall, 0, "nokeepall never answers keepall");
    assert.ok(variant.answerMix.keeplines > 0, "nokeepall keeps through keeplines");
    assert.ok(shipped.answerMix.forgetall > 0 && variant.answerMix.forgetall > 0,
      "both arms forget whole rows");
    assert.notEqual(shipped.askBytes.promptWire, variant.askBytes.promptWire,
      "only the ask grammar's bytes move");
    assert.equal(typeof report.diff.freedNet, "number");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("abReportOf refuses a report that lacks an arm", () => {
  assert.throws(() => abReportOf({ arms: [{ grammar: "jsonl-20", output: null }] }),
    error => error?.code === "sim-ab-grammar-arms");
});
