#!/usr/bin/env node
/**
 * ISSUE-059 T-6 — the lane scorer: lane renders in, one comparison table out,
 * and every ratio carries its n, its |J| and its censoring counts.
 *
 * Usage:
 *   node dev/sim/sim-score.mjs --off <lane-off.json> --lane <name>=<file>...
 *        --record <record.json> --depths <depths.json> [--reference <name>]
 *        [--census <live-census.json>] [--out <file>] [--json]
 *
 *   --off        the OFF lane render (`sim-render.mjs --json` on the record with
 *                no decisions): the baseline every ratio is read against
 *   --lane       one judge lane's render, named. Repeat the flag per lane; K is
 *                the lane whose depth was measured
 *   --record     the moment list (`sim-record.mjs --json`), or the record object
 *                that carries it: |J|, the labelable count and the moment rows
 *   --depths     the measured billed prompt per step, plus the composed window T
 *   --reference  which lane's depth is the MEASURED one; default K, else the one
 *                supplied lane. Two lanes and no K is refused, never guessed
 *   --census     a live-convert `live-census.json`; the only source of the
 *                below-floor and no-legal-answer counts
 *
 * ## Inputs this module does not invent
 *
 * A render carries bytes, never usage: `steps[].prefixBytes` is the lane's own
 * moment turns at that step, and nothing there says what the host billed. So
 * the measured depth is a separate input:
 *
 *   { "windowTokens": 400000,
 *     "schedule": [ { "step": 1, "inputTokens": 1010, "cacheReadTokens": 0 }, … ] }
 *
 * One schedule entry per `assistant/message` that priced a step; `depth` is
 * `inputTokens + cacheReadTokens`, exactly §3.2's billed prompt. The schedule is
 * sparse by construction: the depth at step k is the last entry at or before k.
 *
 * ## The metrics, and how each one is computed
 *
 * §3.1 Tokens per moment. Every moment prints its own row, per lane, never
 *      averaged: `b` original bytes, `kept`, `d` dropped, `o` overhead
 *      (`gaps·marker + summary + framing`), `sigma = d - o` and `tau(sigma)`.
 *      No term is divided by four on its own; `tau(x) = ceil(x/4)` is applied
 *      once, to the moment's whole sigma.
 * §3.2 Depth per step.  D_A(k) = measured(k) + τ(bytes_A(k) − bytes_ref(k)),
 *      where `bytes_A(k)` is the lane's prefix at k (`prefixAt` from
 *      sim-render.mjs, so the arithmetic is the render's own) and ref is the
 *      floor's measured lane. The byte difference IS the sum of that lane's
 *      savings applied before k, so the division happens once, at the end.
 * §3.3 Crossing.        k*(A) = min{k : D_A(k) >= T}; `null` with a reason when
 *      the lane never reaches T by the transcript's last step — never 0.
 * §3.4 Delay.           Δ(A) = k*(A) − k*(OFF), and the raw W pair
 *      W(A) = Σ_{k<k*(A)} D_A(k). W is descriptive: no ratio is printed from
 *      it (§3.6 withdraws ρ).
 * §3.5 Equal work.      S(A) = D_OFF(K_end)/D_A(K_end) at the transcript's last
 *      step, which never goes null; q(k) = D_OFF(k)/D_A(k) over every step,
 *      reported as median, p90, min, max and n.
 * §3.6 No claim. No 3×/10× language and no ρ: the sim cannot make the live-host
 *      claim, so this module prints no percentage and no summed-depth ratio.
 *
 * Median and p90 come from `quantile(sorted, p)` imported from
 * `dev/bench/multiturn/tolerance.mjs` — the plan's own order statistic, never a
 * second implementation and no new dependency.
 *
 * §3.7 (ask overhead) and §3.8 (restore counts) are NOT computed here: both read
 * stage-2 fields (`used`, `rf`, `censoredClass`, ask rows) that no render
 * carries. They are T-10's, and no number is printed for them rather than a
 * guess.
 *
 * ## Honest n and censoring (§4)
 *
 * `J` is the record's moment list; `J_L` is those carrying a renderable path;
 * `N = |J_L|`. Below six, the unit table IS the deliverable: the summary block
 * (S, q, crossing, W) does not print and says why. Above it, every ratio line
 * repeats `n`, `|J|` and the censored classes standing behind it.
 *
 * A censored moment keeps its row, its reason and its depth: `D` on each moment
 * row is that lane's depth at the step the moment landed, so a censored row is
 * neither dropped nor stripped of its reading.
 *
 * All nine census classes are counted and named. A class this module cannot
 * observe prints `null` with its reason; a null is never printed as 0, and a
 * censored moment keeps its row and its depth.
 *
 * Deterministic and offline: no clock, no network, no randomness.
 *
 * Exit: 0 = scored; 2 = a usage error or a named refusal (`<code>: <detail>`).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { quantile } from "../bench/multiturn/tolerance.mjs";
import { prefixAt } from "./sim-render.mjs";
import { optionsOf, parseDevArgs } from "../shared/args.mjs";

const USAGE = [
  "usage: sim-score.mjs --off <lane-off.json> --lane <name>=<file>...",
  "                     --record <record.json> --depths <depths.json>",
  "                     [--reference <name>] [--census <live-census.json>]",
  "                     [--out <file>] [--json]",
  "       --off        the OFF lane render (no decisions): the baseline",
  "       --lane       one judge lane's render, as <name>=<file>; repeatable",
  "       --record     the moment list the lanes were rendered from",
  "       --depths     {windowTokens, schedule:[{step,inputTokens,cacheReadTokens}]}",
  "       --reference  the lane whose depth is measured; default K, else the one lane",
  "       --census     live-census.json: below-floor and no-legal-answer counts",
  "       --out        write the score as JSON (<name>.tmp then rename)",
  "       --json       print the score as JSON instead of the table",
].join("\n");

/** The honest-n line: below six labelled moments the table is the deliverable. */
export const HONEST_N = 6;

/** The nine classes §4 counts, in the plan's order. */
export const CENSOR_CLASSES = Object.freeze([
  "below-floor", "machinery-censored", "ask-failed-fail-open", "unlabelable",
  "failed-join", "censored-at-end", "lane-f-unjudged", "censored-at-cap",
  "no-legal-answer",
]);

/** A refusal with the code a gate asserts on. */
export class SimScoreRefusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "SimScoreRefusal";
    this.code = code;
  }
}

export function refuse(code, detail) {
  throw new SimScoreRefusal(code, detail);
}

/**
 * τ: bytes become tokens once, at the end of a sum (§3). Literal `ceil`, so a
 * negative byte delta rounds toward zero; the bytes column prints beside every
 * τ cell, so no reader has to trust the rounding.
 */
export function tokenizeBytes(bytes) {
  if (!Number.isSafeInteger(bytes)) {
    refuse("sim-score-bytes-invalid", `a byte count is a safe integer, got ${String(bytes)}`);
  }
  return Math.ceil(bytes / 4);
}

/**
 * The measured depth schedule, validated and sorted. `windowTokens` is the
 * composed window T; the schedule's own steps are the only steps with a measured
 * prompt, and each step appears once.
 */
export function parseDepths(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    refuse("sim-score-depths-invalid", "depths is one object: {windowTokens, schedule}");
  }
  const windowTokens = raw.windowTokens;
  if (!Number.isSafeInteger(windowTokens) || windowTokens <= 0) {
    refuse("sim-score-window-invalid",
      `windowTokens is a positive integer token count, got ${String(windowTokens)}`);
  }
  const entries = raw.schedule;
  if (!Array.isArray(entries) || entries.length === 0) {
    refuse("sim-score-depths-absent",
      "depths.schedule is a non-empty array of {step, inputTokens, cacheReadTokens}");
  }
  const schedule = [];
  const seen = new Set();
  for (const entry of entries) {
    const step = entry?.step;
    const inputTokens = entry?.inputTokens;
    const cacheReadTokens = entry?.cacheReadTokens ?? 0;
    if (!Number.isSafeInteger(step) || step < 1) {
      refuse("sim-score-depths-invalid", `a schedule step is a positive integer, got ${String(step)}`);
    }
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) {
      refuse("sim-score-depths-invalid",
        `step ${step} carries inputTokens ${String(inputTokens)}; a billed prompt is a`
        + " non-negative integer");
    }
    if (!Number.isSafeInteger(cacheReadTokens) || cacheReadTokens < 0) {
      refuse("sim-score-depths-invalid",
        `step ${step} carries cacheReadTokens ${String(cacheReadTokens)}; a cache read is a`
        + " non-negative integer");
    }
    if (seen.has(step)) {
      refuse("sim-score-depths-duplicate", `step ${step} carries two measured depths`);
    }
    seen.add(step);
    schedule.push({ step, tokens: inputTokens + cacheReadTokens });
  }
  schedule.sort((left, right) => left.step - right.step);
  return { windowTokens, schedule };
}

/** The measured depth at a step: the last request at or before it, or null. */
export function depthAt(schedule, step) {
  let depth = null;
  for (const entry of schedule) {
    if (entry.step > step) break;
    depth = entry.tokens;
  }
  return depth;
}

/** A render this module can score: rows, a final step, no repeated moment. */
export function validateRender(name, render) {
  if (render === null || typeof render !== "object" || Array.isArray(render)) {
    refuse("sim-score-lane-invalid", `${name} is not a lane render`);
  }
  if (!Array.isArray(render.rows) || render.rows.length === 0) {
    refuse("sim-score-lane-invalid", `${name} carries no rows`);
  }
  if (!Number.isSafeInteger(render.final?.step)) {
    refuse("sim-score-lane-invalid", `${name} carries no final step`);
  }
  const seen = new Set();
  for (const row of render.rows) {
    if (typeof row?.momentId !== "string" || row.momentId.length === 0) {
      refuse("sim-score-lane-invalid", `${name} carries a row with no momentId`);
    }
    if (!Number.isSafeInteger(row.landedStep)) {
      refuse("sim-score-lane-invalid", `${name}: ${row.momentId} carries no landed step`);
    }
    if (typeof row.before !== "string" || typeof row.after !== "string") {
      refuse("sim-score-lane-invalid",
        `${name}: ${row.momentId} carries no before/after body; a render states both`);
    }
    if (!Number.isSafeInteger(row.beforeBytes)) {
      refuse("sim-score-lane-invalid", `${name}: ${row.momentId} carries no beforeBytes`);
    }
    if (seen.has(row.momentId)) {
      refuse("sim-score-duplicate-row", `${name} carries two rows for ${row.momentId}`);
    }
    seen.add(row.momentId);
  }
  return render;
}

/** The record's moment list, whether the caller passed the list or the record. */
export function recordMoments(record) {
  const moments = Array.isArray(record) ? record : record?.moments;
  if (!Array.isArray(moments) || moments.length === 0) {
    refuse("sim-score-record-invalid",
      "the record holds no moment; an empty lane is censored, never scored green");
  }
  const seen = new Set();
  for (const moment of moments) {
    if (typeof moment?.id !== "string" || moment.id.length === 0) {
      refuse("sim-score-record-invalid", "every moment carries its record `id`");
    }
    if (!Number.isSafeInteger(moment.seq) || !Number.isSafeInteger(moment.step)) {
      refuse("sim-score-record-invalid",
        `${moment.id} carries seq ${String(moment.seq)} and step ${String(moment.step)}`);
    }
    if (seen.has(moment.id)) {
      refuse("sim-score-record-invalid", `${moment.id} appears twice in the record`);
    }
    seen.add(moment.id);
  }
  return [...moments].sort((left, right) =>
    (left.seq - right.seq) || left.id.localeCompare(right.id));
}

/** The record's own floor, when it states one; never a guessed 1280. */
function floorOf(record) {
  if (Array.isArray(record)) return null;
  return Number.isSafeInteger(record?.floor) ? record.floor : null;
}

/**
 * One moment in one lane: §3.1's five terms as this lane rendered them.
 *
 * The identity is checked before anything is scored: `kept + dropped` is the
 * original, `kept + gaps·marker + summary + framing` is the body the lane
 * carries, and a whole-body row may not move a byte. A row that does not close
 * is refused by name; it is never scored on one of its two sides.
 *
 * An at-rest proof burn is censored, not scored: it carries no decision and no
 * ledger `d`, so its σ is `null` with the reason, and its bytes still move the
 * prefix (which every lane's depth reads).
 */
export function scoredMoment(name, moment, row) {
  const labelable = typeof moment.path === "string" && moment.path.length > 0;
  const base = {
    seq: moment.seq, step: moment.step, momentId: moment.id,
    label: moment.provenance?.composition ?? moment.provenance?.censoredClass ?? null,
    action: row?.action ?? null,
    labelable, b: null, kept: null, d: null, o: null, sigma: null, tokens: null,
    depth: null, notes: labelable ? [] : ["unlabelable: the moment carries no renderable path"],
  };
  if (row === undefined) {
    return { ...base, notes: [...base.notes, "failed-join: this lane rendered no row for the moment"] };
  }
  const b = row.beforeBytes;
  const afterBytes = Buffer.byteLength(row.after, "utf8");
  if (Number.isSafeInteger(moment.bytes) && moment.bytes !== b) {
    refuse("sim-score-bytes-disagree",
      `${name}: ${moment.id} is ${moment.bytes} bytes in the record and ${b} in the lane;`
      + " the record and the render are not one run");
  }
  if ((row.machinery ?? null) !== null) {
    return {
      ...base, b,
      notes: [...base.notes,
        "machinery-censored: an at-rest burn is no decision and carries no ledger d"],
    };
  }
  const shaped = row.shaped === true;
  const kept = shaped ? row.terms?.kept ?? null : null;
  const d = shaped ? row.terms?.dropped ?? 0 : 0;
  const o = shaped
    ? (row.gaps ?? 0) * (row.terms?.markerBytes ?? 0) + (row.terms?.summary ?? 0)
      + (row.terms?.framing ?? 0)
    : 0;
  if (shaped) {
    if (!Number.isSafeInteger(kept)) {
      refuse("sim-score-terms-disagree", `${name}: ${moment.id} is shaped and carries no kept`);
    }
    if (kept + d !== b) {
      refuse("sim-score-terms-disagree",
        `${name}: ${moment.id} kept ${kept} + dropped ${d} is not its ${b}-byte original`);
    }
    if (kept + o !== afterBytes) {
      refuse("sim-score-terms-disagree",
        `${name}: ${moment.id} kept ${kept} + overhead ${o} is not its ${afterBytes}-byte body`);
    }
  } else if (afterBytes !== b) {
    refuse("sim-score-terms-disagree",
      `${name}: ${moment.id} rewrites nothing, yet its body moved ${b} → ${afterBytes} bytes`);
  }
  return {
    ...base, b, kept, d, o, sigma: d - o, tokens: tokenizeBytes(d - o),
  };
}

/** The first step whose depth reaches T, or null with its reason. */
function crossingOf(name, depth, steps, windowTokens) {
  for (const step of steps) {
    if (depth.get(step) >= windowTokens) return { kStar: step, reason: null };
  }
  return {
    kStar: null,
    reason: `censored-at-end: lane ${name} never reached T=${windowTokens} by the transcript's`
      + ` last step ${steps[steps.length - 1]}`,
  };
}

/** W(A) = Σ_{k<k*(A)} D_A(k); null when the lane never crossed. */
function workBefore(depth, steps, kStar) {
  if (kStar === null) return null;
  let total = 0;
  for (const step of steps) {
    if (step >= kStar) break;
    total += depth.get(step);
  }
  return total;
}

/**
 * §4's nine classes for one lane. A class this lane cannot observe is `null`
 * with its reason, never 0: `below-floor` sits outside the record entirely,
 * `censored-at-cap` is a live-pass fact, and the converter's own counts are
 * absent unless a census is supplied.
 */
function censoringOf({ name, moments, byId, labelable, kStar, census }) {
  const table = census?.compositionTable ?? null;
  const censusCensoring = census?.censoring ?? null;
  const counts = {};
  const reasons = {};
  const count = (key, value, reason) => {
    counts[key] = value;
    if (value === null) reasons[key] = reason;
  };
  count("below-floor", Number.isSafeInteger(table?.["below-floor"]) ? table["below-floor"] : null,
    "no census supplied: a below-floor row is never in the record");
  count("machinery-censored",
    moments.filter(moment => (byId.get(moment.id)?.machinery ?? null) !== null).length, null);
  count("ask-failed-fail-open",
    moments.filter(moment => (moment.provenance?.composition ?? null) === "ask-failed-fail-open").length,
    null);
  count("unlabelable", moments.length - labelable, null);
  count("failed-join", moments.filter(moment => byId.get(moment.id) === undefined).length, null);
  count("censored-at-end", kStar === null ? 1 : 0, null);
  count("lane-f-unjudged", name === "OFF" ? null : moments.filter((moment) => {
    const row = byId.get(moment.id);
    return row !== undefined && row.decisionStep === null && (row.machinery ?? null) === null
      && (moment.provenance?.composition ?? null) !== "ask-failed-fail-open";
  }).length, "OFF is the baseline: it carries no decision by construction");
  count("censored-at-cap", null,
    "this scorer reads no stop marker; the cap is a live-pass fact (T-10)");
  count("no-legal-answer",
    Number.isSafeInteger(censusCensoring?.["no-legal-answer"]) ? censusCensoring["no-legal-answer"] : null,
    "no census supplied: the converter's own censoring counts are absent");
  return { counts, reasons };
}

/**
 * The whole comparison. Every lane is measured against the reference lane's
 * measured depth, and every ratio carries its n, its |J| and the lane's
 * censoring counts.
 */
export function scoreLanes({ off, lanes = {}, record, depths, reference = null, census = null }) {
  const renders = new Map([["OFF", validateRender("OFF", off)]]);
  for (const [name, render] of Object.entries(lanes)) {
    if (name.length === 0) refuse("usage", "--lane needs a name");
    if (renders.has(name)) refuse("sim-score-duplicate-lane", `${name} is supplied twice`);
    renders.set(name, validateRender(name, render));
  }
  // The measured lane: the one whose own session produced the usage rows. K is
  // the measured depth by construction (§2); with no K, a single supplied lane
  // is the only lane the measurement can belong to. Anything else is a guess,
  // and a guess here would silently mislabel every ratio.
  const others = [...renders.keys()].filter(name => name !== "OFF");
  const refName = reference ?? (renders.has("K") ? "K" : others.length === 1 ? others[0] : null);
  if (refName === null) {
    refuse("sim-score-reference-required",
      `no K lane and ${others.length} lanes (${others.join(", ")}); --reference must name`
      + " whose measured depth the schedule is");
  }
  if (!renders.has(refName)) {
    refuse("sim-score-reference-unknown",
      `--reference ${refName} names no supplied lane (${[...renders.keys()].join(", ")})`);
  }
  const moments = recordMoments(record);
  const meters = parseDepths(depths);
  if (census !== null && (typeof census?.compositionTable !== "object"
    || typeof census?.censoring !== "object")) {
    refuse("sim-score-census-invalid",
      "--census needs a live-convert census: compositionTable and censoring");
  }

  // Two runs never share a table: a row the record does not hold means the
  // render and the moment list are from different records.
  const known = new Set(moments.map(moment => moment.id));
  const rowsById = new Map();
  for (const [name, render] of renders) {
    const byId = new Map();
    for (const row of render.rows) {
      if (!known.has(row.momentId)) {
        refuse("sim-score-moment-unknown",
          `${name} carries a row for ${row.momentId}, which the record does not hold`);
      }
      byId.set(row.momentId, row);
    }
    rowsById.set(name, byId);
  }

  const startStep = 1;
  const endStep = Math.max(...[...renders.values()].map(render => render.final.step));
  const steps = [];
  for (let step = startStep; step <= endStep; step += 1) steps.push(step);
  for (const [name, render] of renders) {
    const lastLanded = Math.max(...render.rows.map(row => row.landedStep));
    if (lastLanded >= endStep) {
      refuse("sim-score-end-before-row",
        `${name} lands a result at step ${lastLanded}, which its own last step ${endStep}`
        + " does not come after; the render's `final` is not its last step plus one");
    }
  }

  const measured = new Map();
  let entryIndex = 0;
  let current = null;
  for (const step of steps) {
    while (entryIndex < meters.schedule.length && meters.schedule[entryIndex].step <= step) {
      current = meters.schedule[entryIndex].tokens;
      entryIndex += 1;
    }
    if (current === null) {
      refuse("sim-score-step-unmeasured", `step ${step} precedes the first measured request`);
    }
    measured.set(step, current);
  }

  const refBytes = new Map(steps.map(step => [step, prefixAt(renders.get(refName), step).prefixBytes]));
  const depthByLane = new Map();
  for (const [name, render] of renders) {
    const depth = new Map();
    for (const step of steps) {
      const bytes = prefixAt(render, step).prefixBytes;
      const value = measured.get(step) + tokenizeBytes(bytes - refBytes.get(step));
      if (!Number.isSafeInteger(value) || value <= 0) {
        refuse("sim-score-depth-nonpositive",
          `${name} at step ${step} is ${value} tokens; a depth of zero or less carries no ratio`);
      }
      depth.set(step, value);
    }
    depthByLane.set(name, depth);
  }

  const labelable = moments.filter(moment =>
    typeof moment.path === "string" && moment.path.length > 0).length;
  const offDepth = depthByLane.get("OFF");
  const offCrossing = crossingOf("OFF", offDepth, steps, meters.windowTokens);
  const offWork = workBefore(offDepth, steps, offCrossing.kStar);
  const offEnd = offDepth.get(endStep);

  const out = {};
  for (const [name, render] of renders) {
    const depth = depthByLane.get(name);
    const crossing = crossingOf(name, depth, steps, meters.windowTokens);
    const delta = crossing.kStar === null || offCrossing.kStar === null
      ? null : crossing.kStar - offCrossing.kStar;
    const deltaReason = delta !== null ? null
      : crossing.kStar === null ? crossing.reason
        : offCrossing.reason;
    const work = workBefore(depth, steps, crossing.kStar);
    const ratios = steps.map(step => offDepth.get(step) / depth.get(step))
      .sort((left, right) => left - right);
    const { counts, reasons } = censoringOf({
      name, moments, byId: rowsById.get(name), labelable, kStar: crossing.kStar, census,
    });
    const ratiosFoot = { n: ratios.length, j: moments.length, censoring: counts };
    out[name] = {
      lane: name,
      baseline: name === "OFF",
      reference: name === refName,
      moments: moments.map((moment) => {
        const scored = scoredMoment(name, moment, rowsById.get(name).get(moment.id));
        // A censored moment keeps its depth (§4): the lane's depth at the step
        // the moment landed. A step outside the measured schedule prints null
        // with its reason, never a zero.
        const at = depth.get(moment.step);
        return at === undefined
          ? { ...scored, notes: [...scored.notes,
            `depth null: step ${moment.step} is outside the measured schedule`
            + ` ${steps[0]}..${endStep}`] }
          : { ...scored, depth: at };
      }),
      S: {
        value: offEnd / depth.get(endStep), numerator: offEnd, denominator: depth.get(endStep),
        step: endStep, ...ratiosFoot,
      },
      q: {
        median: quantile(ratios, 0.5), p90: quantile(ratios, 0.9),
        min: ratios[0], max: ratios[ratios.length - 1], ...ratiosFoot,
      },
      crossing: {
        T: meters.windowTokens, kStar: crossing.kStar, reason: crossing.reason,
        offKStar: offCrossing.kStar, offReason: offCrossing.reason,
        delta, deltaReason, n: steps.length, j: moments.length, censoring: counts,
      },
      work: {
        value: work, off: offWork, reason: work === null ? crossing.reason : null,
        offReason: offWork === null ? offCrossing.reason : null,
        n: steps.length, j: moments.length, censoring: counts,
      },
      censoring: { counts, reasons },
    };
  }

  return {
    schema: "racoons-sim-score/1",
    moments: moments.length,
    labelable,
    unlabelable: moments.length - labelable,
    floor: floorOf(record),
    windowTokens: meters.windowTokens,
    reference: refName,
    from: steps[0],
    to: endStep,
    steps: steps.length,
    order: [...renders.keys()],
    lanes: out,
    claims: labelable >= HONEST_N ? { suppressed: false, reason: null } : {
      suppressed: true,
      reason: `${labelable} labelled moment(s) < ${HONEST_N}: the unit table is the deliverable`,
    },
  };
}

/** A ratio, four decimals trimmed but never below two: 1 prints as 1.00. */
export function ratioText(value) {
  const trimmed = value.toFixed(4).replace(/0+$/, "");
  const decimals = (trimmed.split(".")[1] ?? "").length;
  return decimals >= 2 ? trimmed : trimmed.padEnd(trimmed.length + (2 - decimals), "0");
}

const cell = (value, width) => (value === null ? "null" : String(value)).padStart(width);

/** One moment row, per lane: the five terms, their tau, and the depth it landed at. */
function momentLine(row) {
  return `    ${String(row.seq).padStart(3)} ${String(row.step).padStart(4)}`
    + ` ${String(row.label ?? "-").padEnd(21)} ${String(row.action ?? "-").padEnd(11)}`
    + ` ${cell(row.b, 5)} ${cell(row.kept, 6)} ${cell(row.d, 6)} ${cell(row.o, 6)}`
    + ` ${cell(row.sigma, 6)} ${cell(row.tokens, 5)} ${cell(row.depth, 6)}`
    + (row.notes.length === 0 ? "" : `  (${row.notes.join("; ")})`);
}

/** The censored classes with a non-zero count, or `none`. */
function censorFoot(counts) {
  const named = CENSOR_CLASSES
    .filter(name => typeof counts[name] === "number" && counts[name] !== 0)
    .map(name => `${name}:${counts[name]}`);
  return named.length === 0 ? "none" : named.join(",");
}

/** All nine counts: a number, or `null` with its reason. Never a 0 for absent. */
function censorLines(counts, reasons) {
  const numbers = CENSOR_CLASSES.filter(name => typeof counts[name] === "number")
    .map(name => `${name}=${counts[name]}`);
  const absent = CENSOR_CLASSES.filter(name => counts[name] === null)
    .map(name => `${name} (${reasons[name]})`);
  return [
    `    censoring    ${numbers.join(" ")}`,
    ...(absent.length === 0 ? [] : [`                 null: ${absent.join("; ")}`]),
  ];
}

/** The printed table: the moments always, the summary claims only at n >= 6. */
export function tableOf(score) {
  const lines = ["sim-score"];
  lines.push(`  record       J=${score.moments} moments, labelable=${score.labelable},`
    + ` unlabelable=${score.unlabelable}`
    + (score.floor === null ? "" : `, floor=${score.floor} B`));
  lines.push(`  window       T=${score.windowTokens} tokens`);
  lines.push(`  reference    ${score.reference} - this lane's depth is the measured one`);
  lines.push(`  steps        ${score.from}..${score.to} (n=${score.steps})`);
  lines.push(`  quantile     median and p90 from dev/bench/multiturn/tolerance.mjs`);
  for (const name of score.order) {
    const lane = score.lanes[name];
    const tag = lane.baseline ? " (baseline, rebuilt)" : lane.reference ? " (measured)" : "";
    lines.push("", `  lane ${name}${tag}`);
    lines.push("    moments  (one row per moment, never averaged;"
      + " sigma = d - o bytes, tau = ceil(sigma/4) tokens, D = depth at its step)");
    lines.push("     seq step class                 action          b   kept      d      o"
      + "  sigma   tau      D  note");
    for (const row of lane.moments) lines.push(momentLine(row));
    if (score.claims.suppressed) {
      lines.push(`    summary      none - ${score.claims.reason}`);
    } else {
      lines.push(`    S            ${ratioText(lane.S.value)} = D_OFF(${lane.S.step})/D_${name}`
        + `(${lane.S.step}) = ${lane.S.numerator}/${lane.S.denominator}`
        + `  n=${lane.S.n} |J|=${lane.S.j} censored=${censorFoot(lane.S.censoring)}`);
      lines.push(`    q            median ${ratioText(lane.q.median)} p90 ${ratioText(lane.q.p90)}`
        + ` min ${ratioText(lane.q.min)} max ${ratioText(lane.q.max)}`
        + `  n=${lane.q.n} |J|=${lane.q.j} censored=${censorFoot(lane.q.censoring)}`);
      lines.push(`    crossing     k*=${lane.crossing.kStar === null
        ? `null (${lane.crossing.reason})` : lane.crossing.kStar}`
        + `  OFF k*=${lane.crossing.offKStar === null
          ? `null (${lane.crossing.offReason})` : lane.crossing.offKStar}`
        + `  delta=${lane.crossing.delta === null
          ? `null (${lane.crossing.deltaReason})` : lane.crossing.delta}`
        + `  n=${lane.crossing.n} |J|=${lane.crossing.j}`
        + ` censored=${censorFoot(lane.crossing.censoring)}`);
      lines.push(`    W            ${lane.work.value === null
        ? `null (${lane.work.reason})` : lane.work.value}`
        + `  OFF ${lane.work.off === null ? `null (${lane.work.offReason})` : lane.work.off}`
        + "  - descriptive, no ratio (rho is withdrawn)");
    }
    lines.push(...censorLines(lane.censoring.counts, lane.censoring.reasons));
  }
  return lines.join("\n");
}

/** The argument map: the flag as written, the option it sets. */
const FLAGS = optionsOf([
  ["--off", "string"],
  ["--record", "string"],
  ["--depths", "string"],
  ["--reference", "string"],
  ["--census", "string"],
  ["--out", "string"],
  ["--lane", "string", "lanes", { multiple: true }],
  ["--json", "boolean"],
]);

export function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: FLAGS,
    refuse: message => refuse("usage", message),
    help: `${USAGE}\n`,
  });
  // `--lane <name>=<file>`: the pair is one value, split here so the shape is
  // judged in this module's own words rather than the shared scan's.
  const lanes = [];
  for (const value of values.lanes ?? []) {
    const at = value.indexOf("=");
    if (at <= 0 || at === value.length - 1) {
      refuse("usage", `--lane needs <name>=<file>, got ${value}`);
    }
    lanes.push({ name: value.slice(0, at), file: value.slice(at + 1) });
  }
  const opts = {
    off: values.off ?? null,
    lanes,
    record: values.record ?? null,
    depths: values.depths ?? null,
    reference: values.reference ?? null,
    census: values.census ?? null,
    out: values.out ?? null,
    json: values.json ?? false,
  };
  for (const flag of ["off", "record", "depths"]) {
    if (opts[flag] === null) refuse("usage", `--${flag} is required`);
  }
  if (opts.lanes.length === 0) refuse("usage", "at least one --lane <name>=<file> is required");
  const names = new Set();
  for (const lane of opts.lanes) {
    if (lane.name === "OFF") refuse("usage", "OFF is the --off render; name this lane otherwise");
    if (names.has(lane.name)) refuse("usage", `--lane ${lane.name} is given twice`);
    names.add(lane.name);
  }
  if (opts.reference !== null && opts.reference !== "OFF" && !names.has(opts.reference)) {
    refuse("usage", `--reference ${opts.reference} names no supplied lane`);
  }
  return opts;
}

/** A JSON input, named with the code a missing or malformed file earns. */
export function loadJson(file, code) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return refuse(code, `${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return refuse(code, `${file}: ${error.message}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const at = name => path.resolve(process.cwd(), name);
  const off = loadJson(at(opts.off), "sim-score-lane-unreadable");
  const lanes = {};
  for (const lane of opts.lanes) {
    lanes[lane.name] = loadJson(at(lane.file), "sim-score-lane-unreadable");
  }
  const score = scoreLanes({
    off,
    lanes,
    record: loadJson(at(opts.record), "sim-score-record-unreadable"),
    depths: loadJson(at(opts.depths), "sim-score-depths-unreadable"),
    reference: opts.reference,
    census: opts.census === null ? null : loadJson(at(opts.census), "sim-score-census-unreadable"),
  });
  if (opts.out !== null) {
    const target = at(opts.out);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(`${target}.tmp`, `${JSON.stringify(score, null, 2)}\n`);
    renameSync(`${target}.tmp`, target);
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(score, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${tableOf(score)}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    if (error?.code === "usage") process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
}
