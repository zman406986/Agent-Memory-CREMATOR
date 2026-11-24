#!/usr/bin/env node
/**
 * The comparison reader's gate: three hand-written partials in, the
 * pre-registered metric out.
 *
 * Run: `node --test dev/sim/sim-compare.test.mjs`
 *
 * The fixture is inline. A score test that read a `scratchpad/` partial would
 * pin whatever one killed pass happened to write; these rows are the metric's
 * own cases: a full drop, a keep-all, the lane-2 `None` spelling, a guard
 * refusal, an out-of-contract form and an unreadable reply.
 *
 * The oracle for `dropped` is `planEntryShape` itself over the same body, so a
 * re-derivation of the arithmetic here could not pass by agreeing with a second
 * copy of the bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEntryAnswer, planEntryShape, splitLineOffsets } from "@cremator/core";
import {
  CEILING, PRUNE_ROW, compareLanes, formatTable, load, parseArgs, resolveLanes, score,
} from "./sim-compare.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = path.join(HERE, "sim-compare.mjs");
const SNAPSHOT = { sessionId: "sim-compare", revision: "0" };

const utf8 = text => new TextEncoder().encode(text);

/** One trigger body, three lines, 9 B: `aa\nbb\ncc\n` (each line is 3 B). */
const BODY = "aa\nbb\ncc\n";

/** A partial row carrying a reply and the trigger's original body. */
function row(momentId, answer, body = BODY, extra = {}) {
  return { kind: "answer", momentId, status: "answered", answer, original: body, ...extra };
}

/**
 * Three lanes over ONE stage list. Each lane's contract differs; the bodies do
 * not, so the only variable is the answer (plan §3).
 *
 * lane N: keepall (0), keeplines [[1,2]] (drops `cc\n` = 3 B), forgetall (9 B)
 * lane 2: the `None` spelling (0), subset keeplines (out of contract)
 * lane F: forgetlines [[2,2]] (drops `bb\n` = 3 B), keeplines (out of contract)
 */
const fixture = () => ({
  N: [
    row("s1", '{"keepall":true}'),
    row("s2", '{"keeplines":[[1,2],"kept the head"]}'),
    row("s3", '{"forgetall":"all three lines"}'),
  ],
  "2": [
    row("s1", '{"keeplines":[[1,3],"None"]}'),
    row("s2", '{"keeplines":[[1,2],"subsets are not offered"]}'),
    row("s3", '{"forgetall":"all three lines"}'),
  ],
  F: [
    row("s1", '{"forgetlines":[[2,2],"dropped the middle"]}'),
    row("s2", '{"keeplines":[[1,2],"not lane F"]}'),
    row("s3", '{"forgetall":"all three lines"}'),
  ],
});

const scored = lane => score(fixture()[lane], lane);

test("each lane's dropped/answered comes out of the pre-registered arithmetic", () => {
  // The bodies are 9 B and 3 lines; `forgetall` plans 0 kept bytes (9 dropped).
  assert.equal(utf8(BODY).length, 9);
  assert.equal(splitLineOffsets(utf8(BODY)).length, 3);

  // lane N: 0 + 3 + 9 = 12 over three answered asks.
  const n = scored("N");
  assert.equal(n.answered, 3);
  assert.equal(n.dropped, 12);
  assert.equal(n.bytesPerAsk, 4);

  // lane 2: the `None` spelling scores 0, the subset keeplines is excluded,
  // so 0 + 9 = 9 over TWO answered asks (the excluded row is not one).
  const two = scored("2");
  assert.equal(two.answered, 2);
  assert.equal(two.dropped, 9);
  assert.equal(two.bytesPerAsk, 4.5);
  assert.equal(two.outOfContract, 1);

  // lane F: 3 + 9 = 12 over two answered; its keeplines row is excluded whole.
  const f = scored("F");
  assert.equal(f.answered, 2);
  assert.equal(f.dropped, 12);
  assert.equal(f.bytesPerAsk, 6);
  assert.equal(f.outOfContract, 1);
});

test("the fixture's dropped bytes are planEntryShape's own reading", () => {
  for (const lane of ["N", "2", "F"]) {
    const expected = fixture()[lane].reduce((total, entry) => {
      let answer;
      try { answer = parseEntryAnswer(entry.answer); } catch { return total; }
      if (!["keepall", "keeplines", "forgetall", "forgetlines"].includes(answer.action)) {
        return total;
      }
      if (answer.action === "keeplines" && entry.answer.includes("subsets")) return total;
      if (answer.action === "keeplines" && lane === "F") return total;
      const plan = planEntryShape(
        { unitId: entry.momentId, nodeId: entry.momentId,
          originalBytes: utf8(entry.original), answer }, SNAPSHOT);
      if (plan.action === "keepall") return total;
      if (plan.action === "refuse") return total;
      const kept = plan.keptRanges.reduce(
        (sum, range) => sum + (range.endByteExclusive - range.startByte), 0);
      return total + utf8(entry.original).length - kept;
    }, 0);
    assert.equal(scored(lane).dropped, expected, `lane ${lane}`);
  }
});

test("a keepall row scores 0 and counts once in the denominator", () => {
  const keepAllOnly = [row("s1", '{"keepall":true}'), row("s2", '{"keepall":true}')];
  const lane = score(keepAllOnly, "N");
  assert.equal(lane.dropped, 0);
  assert.equal(lane.answered, 2, "two rows, two denominator entries — not 0, not 4");
  assert.equal(lane.bytesPerAsk, 0);
  assert.equal(lane.keepEverything, 2);
  assert.equal(lane.keepEverythingRate, 1);

  // The R1 two-form spelling is keep-everything too: 0 dropped, one entry.
  const twoForm = score([row("s1", '{"keeplines":[[1,3],"None"]}')], "2");
  assert.equal(twoForm.dropped, 0);
  assert.equal(twoForm.answered, 1);
  assert.equal(twoForm.keepEverythingRate, 1);
  assert.equal(twoForm.formMix.keeplines, 1, "the form is still recorded as keeplines");
});

test("a guard refusal is answered at 0 dropped; an unreadable row is not in the denominator", () => {
  const lane = score([
    row("s1", '{"forgetlines":[[1,3],"names every line"]}'), // planner refuses
    row("s2", "not json at all"),                            // null
    row("s3", '{"forgetlines":[[2,2],"dropped the middle"]}'), // 3 B
  ], "F");
  assert.equal(lane.refusals, 1);
  assert.deepEqual(lane.refusalReasons, { "drops-every-line": 1 });
  assert.equal(lane.unreadable, 1);
  assert.equal(lane.answered, 2, "guard refusal counted, unreadable row not");
  assert.equal(lane.dropped, 3);
  assert.equal(lane.bytesPerAsk, 1.5);
});

test("formatTable prints the fixture's rows, totals and the blocked prune row", () => {
  const compare = {
    ceiling: CEILING,
    prune: PRUNE_ROW,
    lanes: [scored("N"), scored("2"), scored("F")],
  };
  const text = formatTable(compare);
  assert.equal(text, [
    "sim-compare - applied post-guard bytes dropped per answered ask",
    "ceiling 2,250,000 billed tokens per lane",
    "",
    "lane N   partial <in-memory>",
    "   stage  step  class     form       dropped  note",
    "   s1     -     answered  keepall    0",
    "   s2     -     answered  keeplines  3",
    "   s3     -     answered  forgetall  9",
    "   totals        answered 3   guard-refused 0   bytes/ask 4.0   keep-everything 33.3%",
    "   forms         keepall 1  keeplines 1  forgetall 1  forgetlines 0",
    "   refusals      guard 0   out-of-contract 0   unreadable 0",
    "   spend         censored (no-billed-usage) / 2,250,000 ceiling",
    "   instruction   300·3 + 12·0 = 900",
    "   prune         blocked (ISSUE-092)",
    "",
    "lane 2   partial <in-memory>",
    "   stage  step  class            form       dropped  note",
    "   s1     -     answered         keeplines  0",
    "   s2     -     out-of-contract  keeplines  -        form-not-offered",
    "   s3     -     answered         forgetall  9",
    "   totals        answered 2   guard-refused 0   bytes/ask 4.5   keep-everything 50.0%",
    "   forms         keepall 0  keeplines 1  forgetall 1  forgetlines 0",
    "   refusals      guard 0   out-of-contract 1   unreadable 0",
    "   spend         censored (no-billed-usage) / 2,250,000 ceiling",
    "   instruction   300·3 + 12·0 = 900",
    "   prune         blocked (ISSUE-092)",
    "",
    "lane F   partial <in-memory>",
    "   stage  step  class            form         dropped  note",
    "   s1     -     answered         forgetlines  3",
    "   s2     -     out-of-contract  keeplines    -        form-not-offered",
    "   s3     -     answered         forgetall    9",
    "   totals        answered 2   guard-refused 0   bytes/ask 6.0   keep-everything 0.0%",
    "   forms         keepall 0  keeplines 0  forgetall 1  forgetlines 1",
    "   refusals      guard 0   out-of-contract 1   unreadable 0",
    "   spend         censored (no-billed-usage) / 2,250,000 ceiling",
    "   instruction   300·3 + 12·0 = 900",
    "   prune         blocked (ISSUE-092)",
  ].join("\n"));
  assert.equal(text.includes("prune 0"), false, "the prune row is never a zero");
});

test("a missing partial renders censored (<reason>), never zero", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "racoons-sim-compare-"));
  try {
    const present = path.join(dir, "lane-n.jsonl");
    writeFileSync(present, `${JSON.stringify(row("s1", '{"keepall":true}'))}\n`);
    const compare = compareLanes({
      lanes: [
        { lane: "N", partial: present },
        { lane: "2", partial: path.join(dir, "absent.jsonl") },
        { lane: "F", partial: path.join(dir, "lane-f", "partial.jsonl") },
      ],
    });
    const missing = compare.lanes[1];
    assert.equal(missing.censored, "partial-missing");
    assert.equal(missing.answered, null);
    assert.equal(missing.dropped, null);
    assert.equal(missing.bytesPerAsk, null);
    assert.equal(missing.spend.billed, null);

    const text = formatTable(compare);
    assert.match(text, /lane 2 .*\n {3}censored \(partial-missing\)/);
    assert.match(text, /lane F .*\n {3}censored \(partial-missing\)/);
    assert.equal(text.includes("answered 1"), true, "lane N alone has one answered ask");
    // LANE N's 0.0 is a scored keepall; the censored lanes carry no ratio at all.
    const blocks = text.split(/\n\n/);
    const lane2Block = blocks.find(block => block.startsWith("lane 2"));
    const laneFBlock = blocks.find(block => block.startsWith("lane F"));
    assert.match(lane2Block, /censored \(partial-missing\)/);
    assert.equal(lane2Block.includes("bytes/ask"), false, "a censored lane prints no zero");
    assert.equal(laneFBlock.includes("bytes/ask"), false);
    assert.equal(text.includes(PRUNE_ROW), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a truncated pass says so; a censored lane neither scores nor throws", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "racoons-sim-compare-"));
  try {
    const partial = path.join(dir, "partial.jsonl");
    writeFileSync(partial, [
      JSON.stringify({ kind: "start", schema: "racoons-sim-live-partial/1", lane: "F" }),
      JSON.stringify(row("s1", '{"forgetlines":[[2,2],"dropped the middle"]}')),
      JSON.stringify({ kind: "stop", completed: 1, reason: "kill-timer", killMs: 5400000 }),
    ].join("\n"));
    const loaded = load(partial);
    assert.equal(loaded.rows.length, 1);
    assert.equal(loaded.censored, null);

    const lane = score(loaded, "F");
    assert.deepEqual(lane.stopped, { reason: "kill-timer", completed: 1 });
    assert.equal(lane.dropped, 3);
    assert.match(formatTable({ ceiling: CEILING, prune: PRUNE_ROW, lanes: [lane] }),
      /stopped {7}kill-timer after 1 asks {3}\(a truncated pass, not a zero\)/);

    const empty = path.join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    const censored = score(load(empty), "N");
    assert.equal(censored.censored, "partial-empty");
    assert.equal(censored.bytesPerAsk, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the CLI ----------------------------------------------------------------

const run = args => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

function writeLanes(dir) {
  const files = {};
  for (const lane of ["N", "2", "F"]) {
    const file = path.join(dir, `lane-${lane.toLowerCase()}.jsonl`);
    writeFileSync(file, `${fixture()[lane].map(entry => JSON.stringify(entry)).join("\n")}\n`);
    files[lane] = file;
  }
  return files;
}

test("the CLI prints the table for three named partials", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "racoons-sim-compare-"));
  try {
    const files = writeLanes(dir);
    const result = run(["--lane-n", files.N, "--lane-2", files["2"], "--lane-f", files.F]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /lane N .*\n/);
    assert.match(result.stdout, /totals {8}answered 3 {3}guard-refused 0 {3}bytes\/ask 4\.0/);
    assert.match(result.stdout, /bytes\/ask 6\.0/);
    assert.match(result.stdout, /prune {9}blocked \(ISSUE-092\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI reads a directory and censors the lanes it does not find", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "racoons-sim-compare-"));
  try {
    const files = writeLanes(dir);
    rmSync(files["2"]);
    const opts = parseArgs(["--dir", dir]);
    assert.deepEqual(resolveLanes(opts).map(entry => entry.lane), ["N", "2", "F"]);

    const result = run(["--dir", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /lane 2 .*\n {3}censored \(partial-missing\)/);
    assert.match(result.stdout, /lane N .*/);
    assert.equal(/answered 0/.test(result.stdout), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI refuses a usage error at exit 2 and prints no table", () => {
  const missing = run(["--lane-n", "a.jsonl"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--lane-2 is required unless --dir is given/);
  assert.equal(missing.stdout, "");

  const unknown = run(["--nope", "x"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument --nope/);

  const ceiling = run(["--lane-n", "a", "--lane-2", "b", "--lane-f", "c", "--ceiling", "0"]);
  assert.equal(ceiling.status, 2);
  assert.match(ceiling.stderr, /--ceiling needs a positive integer/);
});
