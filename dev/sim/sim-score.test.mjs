#!/usr/bin/env node
/**
 * ISSUE-059 T-6 — the lane scorer's gate: the hand arithmetic, the null that is
 * never a zero, the zero-removal lane, the honest-n line, and the fixture.
 *
 * Run: `node --test dev/sim/sim-score.test.mjs`
 *
 * The oracle is arithmetic a reader can redo on paper. The synthetic record has
 * six moments (so the summary prints) and seven measured steps; every cell the
 * scorer prints is computed by hand in the comment above its assertion. The
 * integration case then reads the committed sim fixture through the converter,
 * `sim-record.mjs` and `sim-render.mjs`, so the scorer runs on the same bytes
 * the other tickets use.
 *
 * Nothing opens a socket, reads a clock or writes outside a temp dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEntryAnswer } from "@cremator/core";
import { quantile } from "../bench/multiturn/tolerance.mjs";
import { loadRecord, momentsOf } from "./sim-record.mjs";
import { renderLane } from "./sim-render.mjs";
import {
  CENSOR_CLASSES, HONEST_N, SimScoreRefusal, depthAt, parseDepths, ratioText, scoreLanes,
  tableOf,
} from "./sim-score.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SELF = path.join(HERE, "sim-score.mjs");
const CONVERTER = path.join(REPO_ROOT, "dev", "bench", "multiturn", "live-convert.mjs");
const FIXTURE = path.join(REPO_ROOT, "dev", "bench", "fixtures", "sim");
const TRANSCRIPT = path.join(FIXTURE, "sim.session.v4.jsonl");

const text = n => "x".repeat(n);
const isRefusal = code => error => error instanceof SimScoreRefusal && error.code === code;

/*
 * ---- the synthetic record, and every hand number -------------------------
 *
 * Six moments, one landed per step, each joined by `renderHistory`'s one blank
 * line (2 bytes):
 *
 *   m1 seq 1 step 1  4000 bytes      m4 seq 4 step 4  1600 bytes
 *   m2 seq 2 step 2  3200 bytes      m5 seq 5 step 5  1600 bytes
 *   m3 seq 3 step 3  2400 bytes      m6 seq 6 step 6  1600 bytes
 *
 * The measured billed prompt (input + cacheRead) per step, steps 1..7:
 *
 *   step     1     2     3     4     5     6     7
 *   measured 1000  1100  1200  1300  1400  1500  1600
 *
 * Lane K, the measured lane (the reference): m1 forgetall, m2 keeplines, the
 * rest whole.
 *
 *   m1  kept 0    dropped 4000  1 x 100 marker + 100 summary = 200 overhead
 *       sigma = 4000 - 200 = 3800 ; tau = ceil(3800/4) = 950
 *   m2  kept 2000 dropped 1200  1 x 100 marker + 100 summary = 200 overhead
 *       sigma = 1200 - 200 = 1000 ; tau = ceil(1000/4) = 250
 *   m3..m6 whole: d = o = sigma = tau = 0
 *
 * A decision at step S shows from S+1, so the prefix bytes are:
 *
 *   k     OFF                            K
 *   1     0                              0
 *   2     4000                           4000             (m1 swaps at 2)
 *   3     4000+2+3200        = 7202      200+2+3200    = 3402   (m2 swaps at 3)
 *   4     +2+2400            = 9604      200+2+2200+2+2400 = 4804
 *   5     +2+1600           = 11206      4804+2+1600   = 6406
 *   6     +2+1600           = 12808      6406+2+1600   = 8008
 *   7     +2+1600           = 14410      8008+2+1600   = 9610
 *
 * D_A(k) = measured(k) + ceil((bytes_A(k) - bytes_K(k))/4), and K is the
 * reference, so D_K = measured:
 *
 *   k   D_OFF                       D_K
 *   1   1000                        1000
 *   2   1100                        1100
 *   3   1200 + 3800/4 = +950  = 2150 1200
 *   4   1300 + 4800/4 = +1200 = 2500 1300
 *   5   1400 + 1200           = 2600 1400
 *   6   1500 + 1200           = 2700 1500
 *   7   1600 + 1200           = 2800 1600
 *
 * Lane H is the partial lane: it shares K's m1 forgetall but only trims m2
 * (kept 3000, dropped 200, 1 x 100 marker + 100 summary = 200 overhead, so the
 * turn is 3200 bytes — the original's size; sigma = 0, tau = 0).
 *
 *   bytes H  k=3 3402 (m2 still landed whole) ; k=4 200+2+3200+2+2400 = 5804
 *            k=5 7406 ; k=6 9008 ; k=7 10610
 *   bytes H - bytes K: 0, 0, 0, +1000, +1000, +1000, +1000 -> tau +250
 *   D_H = 1000, 1100, 1200, 1550, 1650, 1750, 1850
 *
 * The composed window is T = 1800:
 *   OFF crosses at k* = 3   (2150 >= 1800; 1100 is not)
 *   K   never crosses       (its last depth is 1600 < 1800) -> k* = null
 *   H   crosses at k* = 7   (1850 >= 1800; 1750 is not) -> delta = 7 - 3 = 4
 *
 *   W(OFF) = 1000 + 1100                       = 2100
 *   W(H)   = 1000+1100+1200+1550+1650+1750     = 8250
 *   S(K)   = D_OFF(7)/D_K(7) = 2800/1600       = 1.75
 *   S(H)   = D_OFF(7)/D_H(7) = 2800/1850       = 1.513513…
 *
 *   q(K) = {1, 1, 2150/1200, 2500/1300, 2600/1400, 2700/1500, 2800/1600}
 *          sorted {1, 1, 1.75, 1.791666…, 1.8, 1.857142…, 1.923076…}
 *          median = sorted[floor(0.5*7)=3] = 2150/1200
 *          p90    = sorted[floor(0.9*7)=6] = 2500/1300   (the max as well)
 *   q(H) = {1, 1, 2150/1200, 2500/1550, 2600/1650, 2700/1750, 2800/1850}
 *          = {1, 1, 1.791666…, 1.612903…, 1.575757…, 1.542857…, 1.513513…}
 *          sorted {1, 1, 1.513513…, 1.542857…, 1.575757…, 1.612903…, 1.791666…}
 *          median = sorted[3] = 2700/1750 ; p90 = sorted[6] = 2150/1200
 *          min = 1 ; max = 2150/1200
 *
 * Lane Z removes nothing: its rows are OFF's, so every D_Z equals D_OFF, every
 * ratio is exactly 1, k* = 3 and delta = 0.
 */
function moment(seq, bytes, path_) {
  return {
    id: `m${seq}`, seq, step: seq, path: path_,
    bytes, provenance: { composition: "forget-with-partials", censoredClass: null },
    record: { atRest: null },
  };
}

/** A shaped row whose five terms close on its own bytes. */
function shapedRow({ momentId, landed, swap, b, kept, dropped, gaps, marker, summary, action }) {
  return {
    momentId, seq: landed, landedStep: landed, decisionStep: swap, swapStep: swap,
    action, shaped: true, machinery: null, censored: null,
    before: text(b), beforeBytes: b,
    after: text(kept + gaps * marker + summary),
    terms: { kept, markerBytes: marker, summary, framing: 0, dropped },
    gaps,
  };
}

/** A whole-body row: nothing rewritten, the record's own whole-body terms. */
function wholeRow({ momentId, landed, b, action = "keepall" }) {
  return {
    momentId, seq: landed, landedStep: landed, decisionStep: null, swapStep: null,
    action, shaped: false, machinery: null, censored: null,
    before: text(b), beforeBytes: b, after: text(b),
    terms: { kept: null, markerBytes: 0, summary: 0, framing: null, dropped: 0 },
    gaps: 0,
  };
}

const SIZES = [4000, 3200, 2400, 1600, 1600, 1600];
const RECORD = SIZES.map((bytes, index) => moment(index + 1, bytes, `C:/sim/arm/m${index + 1}.txt`));
const DEPTHS = {
  windowTokens: 1800,
  schedule: [1000, 1100, 1200, 1300, 1400, 1500, 1600]
    .map((inputTokens, index) => ({ step: index + 1, inputTokens, cacheReadTokens: 0 })),
};

const offRows = () => RECORD.map((entry, index) =>
  wholeRow({ momentId: entry.id, landed: index + 1, b: SIZES[index] }));
const wholeRest = () => RECORD.slice(2).map((entry, index) =>
  wholeRow({ momentId: entry.id, landed: index + 3, b: SIZES[index + 2] }));

const OFF = { lane: "OFF", rows: offRows(), final: { step: 7 } };
const K = {
  lane: "K",
  rows: [
    shapedRow({ momentId: "m1", landed: 1, swap: 2, b: 4000, kept: 0, dropped: 4000,
      gaps: 1, marker: 100, summary: 100, action: "forgetall" }),
    shapedRow({ momentId: "m2", landed: 2, swap: 3, b: 3200, kept: 2000, dropped: 1200,
      gaps: 1, marker: 100, summary: 100, action: "forgetlines" }),
    ...wholeRest(),
  ],
  final: { step: 7 },
};
// H shares K's m1 and only trims m2: kept 3000 + dropped 200 = the 3200-byte
// original, and 3000 + 1x100 marker + 100 summary = the 3200-byte turn. So its
// prefix is K's until the m2 swap and 1000 bytes heavier after it.
const H = {
  lane: "H",
  rows: [
    shapedRow({ momentId: "m1", landed: 1, swap: 2, b: 4000, kept: 0, dropped: 4000,
      gaps: 1, marker: 100, summary: 100, action: "forgetall" }),
    shapedRow({ momentId: "m2", landed: 2, swap: 3, b: 3200, kept: 3000, dropped: 200,
      gaps: 1, marker: 100, summary: 100, action: "forgetlines" }),
    ...wholeRest(),
  ],
  final: { step: 7 },
};
/** The zero-removal lane: OFF's own rows under another name. */
const Z = { lane: "Z", rows: offRows().map(row => ({ ...row })), final: { step: 7 } };

const scored = (lanes = { K, H, Z }) =>
  scoreLanes({ off: OFF, lanes, record: RECORD, depths: DEPTHS });

// ---- the hand arithmetic: every moment cell ------------------------------

test("every moment cell equals its hand number", () => {
  const score = scored();
  const rows = name => score.lanes[name].moments.map(row => ({
    seq: row.seq, b: row.b, kept: row.kept, d: row.d, o: row.o, sigma: row.sigma,
    tau: row.tokens, depth: row.depth,
  }));
  // OFF rewrites nothing: d = o = sigma = tau = 0, kept is null (never 0), and
  // its depth is the rebuilt baseline at that step.
  assert.deepEqual(rows("OFF"), [
    { seq: 1, b: 4000, kept: null, d: 0, o: 0, sigma: 0, tau: 0, depth: 1000 },
    { seq: 2, b: 3200, kept: null, d: 0, o: 0, sigma: 0, tau: 0, depth: 1100 },
    { seq: 3, b: 2400, kept: null, d: 0, o: 0, sigma: 0, tau: 0, depth: 2150 },
    { seq: 4, b: 1600, kept: null, d: 0, o: 0, sigma: 0, tau: 0, depth: 2500 },
    { seq: 5, b: 1600, kept: null, d: 0, o: 0, sigma: 0, tau: 0, depth: 2600 },
    { seq: 6, b: 1600, kept: null, d: 0, o: 0, sigma: 0, tau: 0, depth: 2700 },
  ]);
  assert.deepEqual(rows("K"), [
    { seq: 1, b: 4000, kept: 0, d: 4000, o: 200, sigma: 3800, tau: 950, depth: 1000 },
    { seq: 2, b: 3200, kept: 2000, d: 1200, o: 200, sigma: 1000, tau: 250, depth: 1100 },
    { seq: 3, b: 2400, kept: null, d: 0, o: 0, sigma: 0, tau: 0, depth: 1200 },
    { seq: 4, b: 1600, kept: null, d: 0, o: 0, sigma: 0, tau: 0, depth: 1300 },
    { seq: 5, b: 1600, kept: null, d: 0, o: 0, sigma: 0, tau: 0, depth: 1400 },
    { seq: 6, b: 1600, kept: null, d: 0, o: 0, sigma: 0, tau: 0, depth: 1500 },
  ]);
  // H's m2 turn is exactly as large as the original: sigma 0, tau 0, and the
  // lane's depth is K's plus the 1000-byte trim it did not make.
  assert.deepEqual(rows("H").slice(0, 5), [
    { seq: 1, b: 4000, kept: 0, d: 4000, o: 200, sigma: 3800, tau: 950, depth: 1000 },
    { seq: 2, b: 3200, kept: 3000, d: 200, o: 200, sigma: 0, tau: 0, depth: 1100 },
    { seq: 3, b: 2400, kept: null, d: 0, o: 0, sigma: 0, tau: 0, depth: 1200 },
    { seq: 4, b: 1600, kept: null, d: 0, o: 0, sigma: 0, tau: 0, depth: 1550 },
    { seq: 5, b: 1600, kept: null, d: 0, o: 0, sigma: 0, tau: 0, depth: 1650 },
  ]);
});

test("tau divides once, on the whole sigma, and rounds up", () => {
  assert.equal(scored().lanes.K.moments[0].tokens, 950); // 3800/4, exact
  // A sigma that is not a multiple of four. m2: kept 1997 + dropped 1203 = the
  // 3200-byte original; 1997 + 1x100 marker + 100 summary = a 2197-byte turn.
  // sigma = 1203 - 200 = 1003; 1003/4 = 250.75 -> tau = 251.
  const lane = {
    lane: "Q",
    rows: [wholeRow({ momentId: "m1", landed: 1, b: 4000 }),
      {
        ...K.rows[1],
        before: text(3200), beforeBytes: 3200,
        after: text(2197),
        terms: { kept: 1997, markerBytes: 100, summary: 100, framing: 0, dropped: 1203 },
      },
      ...wholeRest()],
    final: { step: 7 },
  };
  const score = scoreLanes({ off: OFF, lanes: { Q: lane }, record: RECORD, depths: DEPTHS });
  assert.equal(score.lanes.Q.moments[1].sigma, 1003);
  assert.equal(score.lanes.Q.moments[1].tokens, 251);
  // Dividing each term first would give ceil(1203/4) - ... = 301 - 25 - 25 = 251
  // only by luck; a term-wise division of 1003/4 would give 251 too. The point
  // is that the SUM is divided once: 1003 -> 251, while ceil(1003)/4 is not a
  // token count at all. The literal ceiling is what the cell holds.
  assert.equal(score.lanes.Q.moments[1].tokens, Math.ceil(1003 / 4));
});

// ---- the hand arithmetic: S, q, the crossing, W --------------------------

test("S, the crossing, W and q equal their hand numbers", () => {
  const score = scored();
  const off = score.lanes.OFF;
  const k = score.lanes.K;
  const h = score.lanes.H;

  // OFF against itself: S = 2800/2800 = 1, k* = 3, W = 2100, delta = 0.
  assert.equal(off.S.value, 1);
  assert.equal(off.S.numerator, 2800);
  assert.equal(off.S.denominator, 2800);
  assert.equal(off.S.step, 7);
  assert.equal(off.crossing.kStar, 3);
  assert.equal(off.crossing.delta, 0);
  assert.equal(off.work.value, 2100);

  // K: S = 2800/1600 = 1.75, and it never crosses at T = 1800.
  assert.equal(k.S.value, 1.75);
  assert.equal(k.S.numerator, 2800);
  assert.equal(k.S.denominator, 1600);
  assert.equal(k.crossing.kStar, null);
  assert.equal(k.crossing.offKStar, 3);
  assert.equal(k.crossing.delta, null);
  assert.equal(k.work.value, null);
  assert.equal(k.work.off, 2100);
  // q(K): median = sorted[3] = 2150/1200, p90 = sorted[6] = 2500/1300.
  assert.equal(k.q.median, 2150 / 1200);
  assert.equal(k.q.p90, 2500 / 1300);
  assert.equal(k.q.min, 1);
  assert.equal(k.q.max, 2500 / 1300);
  assert.equal(k.q.n, 7);
  assert.equal(k.q.j, 6);

  // H crosses four steps after OFF: k* = 7 vs 3, delta = 4, W = 8250.
  assert.equal(h.crossing.kStar, 7);
  assert.equal(h.crossing.delta, 4);
  assert.equal(h.work.value, 8250);
  assert.equal(h.S.value, 2800 / 1850);
  // q(H): sorted[3] = 2700/1750, sorted[6] = 2150/1200.
  assert.equal(h.q.median, 2700 / 1750);
  assert.equal(h.q.p90, 2150 / 1200);
  assert.equal(h.q.min, 1);
  assert.equal(h.q.max, 2150 / 1200);
});

test("the table prints those numbers, and prints 1 as 1.00", () => {
  const table = tableOf(scored());
  assert.match(table, /^sim-score$/m);
  assert.match(table, /^ {2}record {7}J=6 moments, labelable=6, unlabelable=0$/m);
  assert.match(table, /^ {2}window {7}T=1800 tokens$/m);
  assert.match(table, /^ {2}reference {4}K - this lane's depth is the measured one$/m);
  assert.match(table, /^ {2}steps {8}1\.\.7 \(n=7\)$/m);
  // The moment rows, every term in its own cell.
  assert.match(table,
    /^\s+1\s+1 forget-with-partials\s+forgetall\s+4000\s+0\s+4000\s+200\s+3800\s+950\s+1000$/m);
  assert.match(table,
    /^\s+2\s+2 forget-with-partials\s+forgetlines\s+3200\s+2000\s+1200\s+200\s+1000\s+250\s+1100$/m);
  // A whole-body row prints kept as null, never as 0.
  assert.match(table,
    /^\s+3\s+3 forget-with-partials\s+keepall\s+2400\s+null\s+0\s+0\s+0\s+0\s+2150$/m);
  // S and q, each with its n, its |J| and its censoring counts on the same line.
  assert.match(table, /^ {4}S {12}1\.75 = D_OFF\(7\)\/D_K\(7\) = 2800\/1600 {2}n=7 \|J\|=6 /m);
  assert.match(table,
    /^ {4}q {12}median 1\.7917 p90 1\.9231 min 1\.00 max 1\.9231 {2}n=7 \|J\|=6 /m);
  // K never crosses, so its crossing line says null with the reason.
  assert.match(table, /^ {4}crossing {5}k\*=null \(censored-at-end: lane K never reached T=1800/m);
  // H's crossing, delta and W, all hand numbers.
  assert.match(table, /k\*=7 {2}OFF k\*=3 {2}delta=4 {2}n=7 \|J\|=6 /);
  assert.match(table, /^ {4}W {12}8250 {2}OFF 2100 {2}- descriptive, no ratio/m);
  // ratioText is the formatter these cells come from.
  assert.equal(ratioText(1), "1.00");
  assert.equal(ratioText(1.75), "1.75");
  assert.equal(ratioText(2150 / 1200), "1.7917");
  assert.equal(ratioText(2800 / 1850), "1.5135");
  assert.equal(ratioText(2500 / 1300), "1.9231");
});

// ---- a null is never a zero ---------------------------------------------

test("a lane that never crosses prints null and its reason, never 0", () => {
  const score = scored();
  const k = score.lanes.K;
  // The JSON is strictly null: not 0, not NaN, not "0".
  assert.strictEqual(k.crossing.kStar, null);
  assert.strictEqual(k.crossing.delta, null);
  assert.strictEqual(k.work.value, null);
  assert.match(k.crossing.reason, /^censored-at-end: lane K never reached T=1800/);
  assert.match(k.crossing.reason, /by the transcript's last step 7$/);
  assert.equal(k.crossing.deltaReason, k.crossing.reason);
  // The table prints the null and its reason, and never k*=0 / delta=0 for K.
  const table = tableOf(score);
  assert.match(table, /k\*=null \(censored-at-end: lane K never reached T=1800 by the transcript's last step 7\)/);
  assert.match(table, /delta=null \(censored-at-end: lane K never reached T=1800/);
  assert.match(table, /^ {4}W {12}null \(censored-at-end: lane K never reached T=1800/m);
  const kSection = table.slice(table.indexOf("  lane K (measured)"),
    table.indexOf("  lane H"));
  assert.doesNotMatch(kSection, /k\*=0\b/);
  assert.doesNotMatch(kSection, /delta=0\b/);
  assert.doesNotMatch(kSection, /^ {4}W {12}0\b/m);
  // S and q never go null: they read the same step in both lanes (§3.5).
  assert.equal(k.S.value, 1.75);
  assert.equal(k.crossing.n, 7);
  assert.equal(k.crossing.j, 6);
});

test("a censoring class the scorer cannot observe is null with its reason, never 0", () => {
  const score = scored();
  for (const name of score.order) {
    const { counts, reasons } = score.lanes[name].censoring;
    assert.deepEqual(Object.keys(counts), [...CENSOR_CLASSES]);
    // No census: below-floor is outside the record entirely and no-legal-answer
    // is the converter's own count. Both print null, and both print why.
    assert.strictEqual(counts["below-floor"], null);
    assert.match(reasons["below-floor"], /^no census supplied/);
    assert.strictEqual(counts["no-legal-answer"], null);
    assert.match(reasons["no-legal-answer"], /^no census supplied/);
    // The cap is a live-pass fact; no render can state it.
    assert.strictEqual(counts["censored-at-cap"], null);
    assert.match(reasons["censored-at-cap"], /^this scorer reads no stop marker/);
    // The classes a render CAN see are real zeroes, not nulls.
    assert.strictEqual(counts["failed-join"], 0);
    assert.strictEqual(counts["unlabelable"], 0);
  }
  // The table names the null classes under a `null:` line, never `x=0`.
  const table = tableOf(score);
  assert.match(table, /^ {17}null: below-floor \(no census supplied/m);
  assert.doesNotMatch(table, /below-floor=0/);
  assert.doesNotMatch(table, /no-legal-answer=0/);
});

test("a census supplies the two counts a render cannot see", () => {
  const census = { compositionTable: { "below-floor": 1 }, censoring: { "no-legal-answer": 0 } };
  const score = scoreLanes({ off: OFF, lanes: { K }, record: RECORD, depths: DEPTHS, census });
  const { counts, reasons } = score.lanes.K.censoring;
  assert.strictEqual(counts["below-floor"], 1);
  assert.strictEqual(counts["no-legal-answer"], 0);
  assert.equal(reasons["below-floor"], undefined);
  assert.equal(reasons["no-legal-answer"], undefined);
  // A census that states 0 is a real zero and prints as one.
  assert.match(tableOf(score), /no-legal-answer=0/);
});

// ---- the zero-removal lane ----------------------------------------------

test("a zero-removal lane reproduces OFF exactly: S = q = 1.00", () => {
  // K is the measured lane, so OFF is the rebuilt baseline. Z removes nothing,
  // so its bytes are OFF's, its depths are OFF's and every ratio is exactly 1.
  const score = scored();
  const z = score.lanes.Z;
  const off = score.lanes.OFF;
  assert.equal(score.reference, "K");
  // "Exactly" means every moment row, depth included, is OFF's own.
  assert.deepEqual(z.moments, off.moments);
  assert.equal(z.S.value, 1);          // 2800/2800
  assert.equal(z.q.median, 1);
  assert.equal(z.q.p90, 1);
  assert.equal(z.q.min, 1);
  assert.equal(z.q.max, 1);
  assert.equal(z.crossing.kStar, 3);   // the same step OFF reaches T at
  assert.equal(z.crossing.offKStar, 3);
  assert.equal(z.crossing.delta, 0);
  assert.equal(z.work.value, 2100);
  assert.equal(z.work.off, 2100);
  const table = tableOf(score);
  assert.match(table, /S {12}1\.00 = D_OFF\(7\)\/D_Z\(7\) = 2800\/2800/);
  assert.match(table, /q {12}median 1\.00 p90 1\.00 min 1\.00 max 1\.00/);
  assert.match(table, /k\*=3 {2}OFF k\*=3 {2}delta=0/);
});

test("with no K the single supplied lane is the measured one, and Z is still 1", () => {
  // One lane and no K: the schedule can only be that lane's own measurement, so
  // it is the reference. Z's bytes are OFF's, so both sides move by the same
  // delta and every ratio is still exactly 1.
  const score = scoreLanes({ off: OFF, lanes: { Z }, record: RECORD, depths: DEPTHS });
  assert.equal(score.reference, "Z");
  assert.equal(score.lanes.Z.S.value, 1);
  assert.equal(score.lanes.Z.q.median, 1);
  assert.equal(score.lanes.Z.q.min, 1);
  assert.equal(score.lanes.Z.q.max, 1);
  // Two lanes and no K: whose measurement the schedule is cannot be inferred, so
  // it is refused rather than assumed.
  assert.throws(() => scoreLanes({
    off: OFF, lanes: { Z, H }, record: RECORD, depths: DEPTHS,
  }), isRefusal("sim-score-reference-required"));
});

// ---- the honest-n line ---------------------------------------------------

test("fewer than six labelled moments prints the table only", () => {
  const record = RECORD.slice(0, 3);
  const off = { lane: "OFF", rows: offRows().slice(0, 3), final: { step: 4 } };
  const k = { lane: "K", rows: K.rows.slice(0, 3), final: { step: 4 } };
  const score = scoreLanes({ off, lanes: { K: k }, record, depths: DEPTHS });
  assert.equal(score.labelable, 3);
  assert.equal(score.moments, 3);
  assert.equal(HONEST_N, 6);
  assert.deepEqual(score.claims, {
    suppressed: true,
    reason: "3 labelled moment(s) < 6: the unit table is the deliverable",
  });
  const table = tableOf(score);
  // The unit table is there, row by row...
  assert.match(table, /^\s+1\s+1 forget-with-partials/m);
  for (const name of score.order) assert.match(table, new RegExp(`lane ${name}`));
  assert.match(table,
    /summary {6}none - 3 labelled moment\(s\) < 6: the unit table is the deliverable/);
  // ...and not one summary claim is.
  assert.doesNotMatch(table, /^\s{4}S\s{6,}/m);
  assert.doesNotMatch(table, /^\s{4}q\s{6,}/m);
  assert.doesNotMatch(table, /^\s{4}crossing/m);
  assert.doesNotMatch(table, /^\s{4}W\s{6,}/m);
  // The JSON still carries the numbers; only the printed claims are withheld.
  assert.equal(score.lanes.K.q.median !== null, true);
});

test("six moments where one is unlabelable stay below the line", () => {
  const record = RECORD.map((entry, index) => (index === 5 ? { ...entry, path: null } : entry));
  const score = scoreLanes({ off: OFF, lanes: { K }, record, depths: DEPTHS });
  assert.equal(score.moments, 6);
  assert.equal(score.labelable, 5);
  assert.equal(score.unlabelable, 1);
  assert.equal(score.claims.suppressed, true);
  // The unlabelable moment keeps its row and says why; it is not dropped.
  const row = score.lanes.K.moments.find(entry => entry.seq === 6);
  assert.equal(row.labelable, false);
  assert.ok(row.notes.includes("unlabelable: the moment carries no renderable path"));
  assert.equal(score.lanes.K.censoring.counts.unlabelable, 1);
  assert.match(tableOf(score), /summary {6}none - 5 labelled moment\(s\) < 6/);
});

// ---- the imported quantile ----------------------------------------------

test("median and p90 are the tolerance util's order statistic, not an average", () => {
  // Stated once from the shipped function: index = floor(p * n), clamped.
  assert.equal(quantile([1, 2, 3, 4], 0.5), 3);
  assert.equal(quantile([1, 2, 3, 4], 0.9), 4);
  assert.equal(quantile([], 0.5), null);
  // The scorer's q cells obey that rule on the synthetic ratios.
  const ratios = [1, 1, 2150 / 1200, 2500 / 1300, 2600 / 1400, 2700 / 1500, 2800 / 1600]
    .sort((left, right) => left - right);
  assert.equal(quantile(ratios, 0.5), 2150 / 1200);
  assert.equal(quantile(ratios, 0.9), 2500 / 1300);
  assert.equal(scored().lanes.K.q.median, quantile(ratios, 0.5));
  assert.equal(scored().lanes.K.q.p90, quantile(ratios, 0.9));
  // Non-vacuity: the order statistic differs from the mean here, so a
  // hand-rolled average would fail.
  const mean = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
  assert.notEqual(mean, quantile(ratios, 0.5));
  // And the module imports the util rather than defining its own.
  const source = readFileSync(SELF, "utf8");
  assert.match(source, /import \{ quantile \} from "\.\.\/bench\/multiturn\/tolerance\.mjs";/);
  assert.doesNotMatch(source, /function quantile\s*\(/);
});

// ---- refusals: a number is never invented -------------------------------

test("a lane that cannot be scored is refused by name", () => {
  const run = (overrides = {}) => () => scoreLanes({
    off: OFF, lanes: { K }, record: RECORD, depths: DEPTHS, ...overrides,
  });
  assert.throws(run({ off: { rows: [] } }), isRefusal("sim-score-lane-invalid"));
  assert.throws(run({ off: { ...OFF, final: {} } }), isRefusal("sim-score-lane-invalid"));
  assert.throws(run({ record: [] }), isRefusal("sim-score-record-invalid"));
  assert.throws(run({ depths: { windowTokens: 2700 } }), isRefusal("sim-score-depths-absent"));
  assert.throws(run({ depths: { windowTokens: 0, schedule: DEPTHS.schedule } }),
    isRefusal("sim-score-window-invalid"));
  assert.throws(run({ lanes: { K, K2: K }, reference: "nope" }),
    isRefusal("sim-score-reference-unknown"));
  assert.throws(run({ record: RECORD.slice(0, 5) }), isRefusal("sim-score-moment-unknown"));
  // The five terms must close: kept + dropped is the original, kept + overhead
  // is the body the lane carries.
  const brokenDrop = { ...K, rows: K.rows.map(row => (row.momentId === "m2"
    ? { ...row, terms: { ...row.terms, dropped: 1201 } } : row)) };
  assert.throws(run({ lanes: { K: brokenDrop } }), isRefusal("sim-score-terms-disagree"));
  const brokenBody = { ...K, rows: K.rows.map(row => (row.momentId === "m3"
    ? { ...row, after: text(2401) } : row)) };
  assert.throws(run({ lanes: { K: brokenBody } }), isRefusal("sim-score-terms-disagree"));
  // The record's byte count and the lane's must come from one run.
  assert.throws(run({ record: [{ ...RECORD[0], bytes: 4001 }, ...RECORD.slice(1)] }),
    isRefusal("sim-score-bytes-disagree"));
  // A step with no measured prompt is refused, never filled in.
  assert.throws(run({
    depths: { ...DEPTHS, schedule: DEPTHS.schedule.filter(entry => entry.step !== 1) },
  }), isRefusal("sim-score-step-unmeasured"));
  // A depth that can carry no ratio is refused: a zero measured prompt with no
  // byte saving at step 1 is a depth of 0.
  assert.throws(run({
    depths: { windowTokens: 2700, schedule: DEPTHS.schedule.map(entry => ({
      ...entry, inputTokens: 0, cacheReadTokens: 0,
    })) },
  }), isRefusal("sim-score-depth-nonpositive"));
});

test("a duplicated or malformed schedule is refused by name", () => {
  assert.throws(() => parseDepths({ windowTokens: 1, schedule: [
    { step: 1, inputTokens: 1 }, { step: 1, inputTokens: 2 }] }),
  isRefusal("sim-score-depths-duplicate"));
  assert.throws(() => parseDepths({ windowTokens: 1, schedule: [{ step: 0, inputTokens: 1 }] }),
    isRefusal("sim-score-depths-invalid"));
  assert.throws(() => parseDepths({ windowTokens: 1, schedule: [{ step: 1, inputTokens: -1 }] }),
    isRefusal("sim-score-depths-invalid"));
});

test("depthAt reads the last request at or before the step", () => {
  const parsed = parseDepths({
    windowTokens: 100,
    schedule: [{ step: 2, inputTokens: 10, cacheReadTokens: 5 },
      { step: 5, inputTokens: 20, cacheReadTokens: 0 }],
  });
  assert.equal(depthAt(parsed.schedule, 1), null);
  assert.equal(depthAt(parsed.schedule, 2), 15);
  assert.equal(depthAt(parsed.schedule, 4), 15);
  assert.equal(depthAt(parsed.schedule, 9), 20);
});

// ---- every ratio row carries n, |J| and the censoring counts ------------

test("every ratio row carries n, |J| and all nine censoring counts", () => {
  const score = scored();
  for (const name of score.order) {
    const lane = score.lanes[name];
    for (const key of ["S", "q", "crossing", "work"]) {
      const foot = lane[key];
      assert.equal(foot.n, 7, `${name}.${key}.n is the step count`);
      assert.equal(foot.j, 6, `${name}.${key}.j is |J|`);
      assert.deepEqual(Object.keys(foot.censoring), [...CENSOR_CLASSES],
        `${name}.${key} does not carry all nine classes`);
    }
    // The printed S, q, crossing and W lines each carry n, |J| and the counts.
    const table = tableOf(score);
    const section = table.slice(table.indexOf(`  lane ${name}`));
    for (const line of section.split("\n").filter(entry => /^ {4}(S|q|W) /.test(entry))) {
      if (line.trim().startsWith("W")) continue; // W is descriptive: no ratio, no foot
      assert.match(line, /n=7 \|J\|=6 censored=/);
    }
  }
});

// ---- the committed fixture, end to end ----------------------------------

/** The fixture converted and rendered once; every fixture test reads one build. */
let cached = null;
function fixture() {
  if (cached !== null) return cached;
  const root = mkdtempSync(path.join(tmpdir(), "racoons-sim-score-"));
  try {
    const out = path.join(root, "out");
    const converted = spawnSync(process.execPath,
      [CONVERTER, "--manifest", path.join(FIXTURE, "manifest.json"), "--out", out],
      { encoding: "utf8" });
    assert.equal(converted.status, 0, converted.stderr);
    const transcriptRows = readFileSync(TRANSCRIPT, "utf8")
      .split("\n").filter(line => line.trim().length > 0).map(line => JSON.parse(line));
    const landed = new Map();
    for (const row of transcriptRows) {
      if (row.type === "tool/result" && row.surfaceOp === "append") {
        landed.set(row.seq, textOf(row));
      }
    }
    const answers = new Map();
    let lastLanded = null;
    for (const row of transcriptRows) {
      if (row.type === "tool/result" && row.surfaceOp === "append") {
        lastLanded = row.seq;
        continue;
      }
      if (row.type !== "assistant/message" || row.surfaceOp !== "append") continue;
      let answer;
      try {
        answer = parseEntryAnswer(textOf(row));
      } catch {
        continue;
      }
      if (lastLanded !== null) answers.set(lastLanded, { step: row.data.step, answer });
    }
    const burns = new Map();
    for (const row of transcriptRows) {
      if (row.type !== "tool/result" || typeof row.surfaceOp !== "object") continue;
      if (row.surfaceOp.startSeq !== row.surfaceOp.endSeq) continue;
      if (!textOf(row).startsWith("[not retained]")) continue;
      burns.set(row.surfaceOp.startSeq, row.data.step);
    }
    const loaded = loadRecord(out);
    const moments = momentsOf(loaded).map(entry => ({
      ...entry,
      original: { ...entry.original, text: landed.get(entry.seq) },
      source: { nodeId: `sim-result-${path.basename(entry.path)}` },
      ...(entry.record?.atRest == null ? {} : {
        record: { ...entry.record,
          atRest: { ...entry.record.atRest, step: burns.get(entry.seq) ?? null } },
      }),
    }));
    const record = { floor: loaded.census.floor, moments };
    const decisions = moments
      .filter(entry => answers.has(entry.seq))
      .map(entry => ({
        momentId: entry.id, step: answers.get(entry.seq).step,
        answer: answers.get(entry.seq).answer,
      }));
    // The measured schedule is the transcript's own usage rows: billed prompt =
    // input + cacheRead, one per assistant message, steps 1..14.
    const schedule = transcriptRows
      .filter(row => row.type === "assistant/message" && row.surfaceOp === "append")
      .map(row => ({
        step: row.data.step,
        inputTokens: row.data.usage?.inputTokens ?? 0,
        cacheReadTokens: row.data.usage?.cacheReadTokens ?? 0,
      }));
    const off = renderLane({ lane: "racoons", moments, decisions: [] });
    const lane = renderLane({ lane: "racoons", moments, decisions });
    const census = JSON.parse(readFileSync(path.join(out, "live-census.json"), "utf8"));
    cached = { record, off, lane, schedule, census };
    return cached;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** The message text one transcript row carries; a row's content parts, joined. */
function textOf(row) {
  const content = row.data?.message?.content;
  if (Array.isArray(content)) {
    return content.filter(part => part.type === "text").map(part => part.text).join("");
  }
  const parts = row.data?.content;
  if (!Array.isArray(parts)) return "";
  return parts.filter(part => typeof part.text === "string").map(part => part.text).join("");
}

test("the fixture's two lanes score with a crossing, and the numbers are the render's", () => {
  const built = fixture();
  const score = scoreLanes({
    off: built.off, lanes: { K: built.lane }, record: built.record,
    depths: { windowTokens: 1100, schedule: built.schedule }, census: built.census,
  });
  assert.equal(score.moments, 7);
  assert.equal(score.labelable, 7);
  assert.equal(score.claims.suppressed, false);
  assert.equal(score.reference, "K");
  assert.equal(score.from, 1);
  assert.equal(score.to, 15);
  assert.equal(score.steps, 15);

  /*
   * The depth table, from the fixture's own measured schedule and prefix bytes:
   * D_OFF(step) = measured(step) + ceil((bytesOff - bytesK) / 4), D_K(step) =
   * measured(step). The marker reads `· necromancy ` now, four bytes longer than
   * the pre-rename `· recall `, so each shaped step's OFF depth loses one token:
   * by the last step the six markers move D_OFF from 1903 to 1897.
   *
   *   step  measured  D_OFF   D_K
   *    1     1010      1010    1010
   *    3     1030      1023    1030
   *    4     1040      1033    1040
   *    5     1050      1181    1050
   *    7     1070      1667    1070
   *    9     1090      1687    1090
   *   11     1110      1707    1110
   *   13     1130      1727    1130
   *   15     1140      1897    1140   (last step)
   *
   * At T = 1100: OFF crosses at k* = 5 (1181 >= 1100; 1033 is not), K at
   * k* = 10 (1100 >= 1100), so delta = 5. W(K) = 1010+…+1090 = 9450,
   * W(OFF) = 1010+1020+1023+1033 = 4086. S(K) = 1897/1140.
   */
  const k = score.lanes.K;
  assert.equal(k.crossing.offKStar, 5);
  assert.equal(k.crossing.kStar, 10);
  assert.equal(k.crossing.delta, 5);
  assert.equal(k.work.value, 9450);
  assert.equal(k.work.off, 4086);
  assert.equal(k.S.value, 1897 / 1140);
  assert.equal(k.S.numerator, 1897);
  assert.equal(k.S.denominator, 1140);
  assert.equal(k.q.min, 1023 / 1030);
  assert.equal(k.q.max, 1897 / 1140);
  assert.equal(k.q.n, 15);
  assert.equal(k.q.j, 7);

  // The censoring the fixture actually carries.
  const counts = score.lanes.K.censoring.counts;
  assert.equal(counts["machinery-censored"], 1);
  assert.equal(counts["ask-failed-fail-open"], 1);
  assert.equal(counts["failed-join"], 0);
  assert.equal(counts.unlabelable, 0);
  assert.equal(counts["censored-at-end"], 0);
  assert.equal(counts["below-floor"], 1);       // from the converter's census
  assert.equal(counts["no-legal-answer"], 0);  // the census's own zero

  // The burn is censored, not scored: no d, no sigma, and its row says why.
  const burn = score.lanes.K.moments.find(row => row.seq === 48);
  assert.equal(burn.d, null);
  assert.equal(burn.sigma, null);
  assert.ok(burn.notes.some(note => note.startsWith("machinery-censored:")));
  assert.notEqual(burn.depth, null, "a censored row keeps its depth");
  // The keepall rewrites nothing, so its sigma is a real zero.
  const keepall = score.lanes.K.moments.find(row => row.seq === 38);
  assert.equal(keepall.d, 0);
  assert.equal(keepall.sigma, 0);
  assert.equal(keepall.tokens, 0);
  // The forgetall drops its whole body; its sigma is d minus its overhead.
  const forgetall = score.lanes.K.moments.find(row => row.seq === 27);
  assert.equal(forgetall.d, 2016);
  assert.equal(forgetall.o, 1 * 122 + 32);
  assert.equal(forgetall.sigma, 2016 - 154);
});

test("the fixture's real window makes every lane print null with its reason", () => {
  const built = fixture();
  // The composed window is the record's own 400 000 and no lane reaches it.
  const score = scoreLanes({
    off: built.off, lanes: { K: built.lane }, record: built.record,
    depths: { windowTokens: 400000, schedule: built.schedule },
  });
  const k = score.lanes.K;
  assert.strictEqual(k.crossing.kStar, null);
  assert.strictEqual(k.crossing.offKStar, null);
  assert.strictEqual(k.crossing.delta, null);
  assert.strictEqual(k.work.value, null);
  assert.strictEqual(k.work.off, null);
  assert.match(k.crossing.reason, /^censored-at-end: lane K never reached T=400000/);
  assert.match(k.crossing.deltaReason, /^censored-at-end: lane K never reached T=400000/);
  assert.match(k.work.offReason, /^censored-at-end: lane OFF never reached T=400000/);
  // S and q never go null: equal work is defined at the last step either way.
  assert.equal(k.S.value, 1897 / 1140);
  assert.equal(k.q.n, 15);
  const table = tableOf(score);
  assert.match(table, /k\*=null \(censored-at-end: lane K never reached T=400000/);
  assert.match(table, /^ {4}W {12}null \(censored-at-end: lane K never reached T=400000/m);
});

test("the CLI prints the table and writes the same score as JSON", () => {
  const built = fixture();
  const root = mkdtempSync(path.join(tmpdir(), "racoons-sim-score-cli-"));
  try {
    const write = (name, value) => {
      const file = path.join(root, name);
      writeFileSync(file, `${JSON.stringify(value)}\n`);
      return file;
    };
    const off = write("off.json", built.off);
    const lane = write("lane-k.json", built.lane);
    const record = write("record.json", built.record);
    const depths = write("depths.json", { windowTokens: 1100, schedule: built.schedule });
    const census = write("census.json", built.census);
    const out = path.join(root, "score.json");

    const none = spawnSync(process.execPath, [SELF], { encoding: "utf8" });
    assert.equal(none.status, 2);
    assert.match(none.stderr, /^usage: --off is required/);

    const run = spawnSync(process.execPath, [SELF, "--off", off, "--lane", `K=${lane}`,
      "--record", record, "--depths", depths, "--census", census, "--out", out],
    { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^sim-score$/m);
    assert.match(run.stdout, /^ {2}record {7}J=7 moments, labelable=7, unlabelable=0, floor=1280 B$/m);
    assert.match(run.stdout, /^ {4}S {12}1\.664 = D_OFF\(15\)\/D_K\(15\) = 1897\/1140/m);
    const written = JSON.parse(readFileSync(out, "utf8"));
    const expected = scoreLanes({
      off: built.off, lanes: { K: built.lane }, record: built.record,
      depths: { windowTokens: 1100, schedule: built.schedule }, census: built.census,
    });
    assert.equal(JSON.stringify(written), JSON.stringify(expected));

    // --json prints the same object the table is rendered from.
    const asJson = spawnSync(process.execPath, [SELF, "--off", off, "--lane", `K=${lane}`,
      "--record", record, "--depths", depths, "--census", census, "--json"],
    { encoding: "utf8" });
    assert.equal(asJson.status, 0, asJson.stderr);
    const parsed = JSON.parse(asJson.stdout);
    assert.equal(parsed.lanes.K.S.value, 1897 / 1140);
    assert.equal(tableOf(parsed), tableOf(expected));

    // A depths file that is not JSON is refused by name.
    const bad = path.join(root, "bad.json");
    writeFileSync(bad, "{nope}\n");
    const refused = spawnSync(process.execPath, [SELF, "--off", off, "--lane", `K=${lane}`,
      "--record", record, "--depths", bad], { encoding: "utf8" });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /^sim-score-depths-unreadable: /);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("the same inputs score byte-identically twice", () => {
  const built = fixture();
  const args = {
    off: built.off, lanes: { K: built.lane }, record: built.record,
    depths: { windowTokens: 1100, schedule: built.schedule }, census: built.census,
  };
  assert.equal(JSON.stringify(scoreLanes(args)), JSON.stringify(scoreLanes(args)));
  assert.equal(tableOf(scoreLanes(args)), tableOf(scoreLanes(args)));
});

// ---- no new dependency ---------------------------------------------------

test("the module imports only node builtins and repo modules", () => {
  const source = readFileSync(SELF, "utf8");
  const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map(match => match[1]);
  const allowed = new Set([
    "node:fs", "node:path", "node:url",
    "../bench/multiturn/tolerance.mjs", "./sim-render.mjs",
    // `dev/lib/args.mjs` is dev's one argument parser (ISSUE-072). It is a
    // file in this repo, not a package: the no-new-dependency rule holds.
    "../shared/args.mjs",
  ]);
  for (const specifier of specifiers) {
    assert.ok(allowed.has(specifier), `unexpected import ${specifier}`);
  }
  // And the working tree carries no package.json change: no dependency landed.
  const status = spawnSync("git", ["status", "--porcelain", "--", "package.json"],
    { cwd: REPO_ROOT, encoding: "utf8" });
  if (status.status === 0) {
    assert.equal(status.stdout.trim(), "", `package.json changed: ${status.stdout}`);
  }
});
