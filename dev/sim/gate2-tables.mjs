#!/usr/bin/env node
// Gate 2, re-pointed at the TABLE lane (ISSUE-020 chunk 4, ISSUE-033 item 2),
// and bound to the SHIPPED core (ISSUE-035 item 2).
//
//   node dev/sim/gate2-tables.mjs --out <dir> [--flip <tableId>] [--arm off|on|both] [--quiet]
//
// The directory is what `run-v4-full.mjs` wrote: run-v4-tables.jsonl and
// run-v4-tables-summary.json. Offline only: no network, no LLM, no clock.
//
// The table lane has no per-call context.jsonl: ONE table = ONE frozen prefix.
// This gate REBUILDS every table's prefix from pristine turn blocks plus that
// table's applied-removal set and asserts:
//
//   (a) recompute — the recomputed prefix's sha256 and byte length equal the
//       row's recorded prefixSha256 / prefixBytes, per table and per arm. The
//       ON arm's frozen removal set is reconstructed from the OFF rows' own
//       verdicts (the runner's one-way freeze), and its sha256 must match
//       summary.frozen.sha256 before any prefix is trusted.
//   (b) extension — inside each epoch, two tables ending at the same turn are
//       byte-equal and a later turn's prefix byte-extends the earlier one.
//       Fails as `same-turn-break` / `no-extension`.
//   (c) epoch plan and base — the product's own `epochsFor` re-derives the
//       epoch plan from the rows' calls and the frozen decisions; every row's
//       epochKey/epochIndex/epochBase and every summary epoch record must
//       match it. Each epoch's recorded basePrefixSha256 equals its first
//       table's recomputed hash. Fails as `epoch-plan` / `epoch-base`.
//   (d) receipts — every applied removal's receipt renders in its prefix (the
//       runner's assertion, read again from the rebuilt bytes).
//   (e) arm pair — until a frozen removal is visible, the ON prefix is the OFF
//       prefix byte for byte (the arms differ only by receipts).
//   (f) non-vacuity — `--flip <tableId>` mutates one byte of that table's
//       recomputed prefix (both arms unless --arm names one), so (a) must go
//       red for it. A green flip run means the check cannot fail and is void.
//
// Exit codes: 0 all green, 1 a gate assertion failed, 2 usage or input error.
// Every failure prints `FAIL <class> <detail>`; a clean run prints one PASS
// line per epoch plus a GREEN line.
//
// WHERE THE RECOMPUTE ENGINE COMES FROM — the SHIPPED package entry.
// A recompute only means something if it runs the product's own code, so the
// gate imports the built core entry `<DIST_ROOT>/index.js` and rebuilds with
// exactly these exports (no sim builder sits in the recompute path):
//
//   renderHistory     judge/assembly.ts   joins the turn texts into one prefix
//   receiptLine       rules/assets.ts     renders every applied receipt
//   appliedSetAt      epochs/removal.ts   the applied set a table sees
//   epochsFor         epochs/epochs.ts    the epoch plan and its same-turn groups
//   canonicalRanges   epochs/removal.ts   sorts/merges the frozen removal ranges
//   sha256Sync        util/hash.ts        every hash this gate compares
//
// A change to any of those reddens the gate (recompute-sha, epoch-base,
// epoch-plan, receipt-missing), so a sim-vs-product divergence cannot pass.
//
// DIST_ROOT — the frozen build the run recorded:
//
//   CREMATOR_SIM_DIST=<dir>   a frozen copy, e.g.
//                            scratchpad/spike-008/v4/.dist-head-2026-10-24/
//   default                  <repo>/packages/core/dist (the live build)
//
// The frozen copy quoted by the tracked note is the HEAD build at commit
// fcad5e5, frozen 2026-10-24 (105 JS modules; prune/ask-carry.js bb24f61a…).
// The harness reads the same tree through `CREMATOR_SIM_DIST`; the gate refuses
// (exit 2) if the two ever resolve to different directories.
//
// NAMED UNBOUND RESIDUE — no shipped export exists, so the gate still carries
// these sim-side pieces, and the tracked note says so:
//
//   - the turn-block parser and unit catalogue (`loadBundle`,
//     `renderPristineSegment`): the product has no conversation parser;
//   - the receipt splice (one receipt per removed line gap; a whole-unit
//     removal renders as the receipt alone, header and trailing blanks kept
//     otherwise): no shipped renderer;
//   - recall-id minting (`buildRecallManifest`/`manifestSha256`/`recallIdFor`
//     are dist modules, not public exports): the simulated bank mints them;
//   - the table-ask composition and the fork appends (gate 1's surface).
//
// DIST HAZARD, NAMED. The summary records the sha256 of every dist module the
// run rendered from; this gate re-hashes each one against the tree it is about
// to read and refuses (exit 2) on any drift. That refusal says "rebuild since
// the run", not "the lane broke". `CREMATOR_SIM_DIST` is how a run and its later
// gate avoid straddling a concurrent rebuild.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkAppliedSets, checkEpochPlan, deriveEpochsByArm,
} from "./epoch-checks.mjs";
import { optionsOf, parseDevArgs } from "../shared/args.mjs";

const USAGE = [
  "usage: gate2-tables.mjs --out <dir> [--flip <tableId>] [--arm off|on|both] [--quiet]",
  "                      [--harness <dir>]",
  "       --out       directory written by run-v4-full.mjs",
  "       --flip      mutate one byte of that table's recomputed prefix (non-vacuity)",
  "       --arm       which arm --flip targets: off, on or both (default both)",
  "       --harness   simulation harness root (default: scratchpad/spike-008/v4,",
  "                   or CREMATOR_SIM_HARNESS); it reads the same CREMATOR_SIM_DIST",
  "       CREMATOR_SIM_DIST pins the shipped core build this gate recomputes with",
].join("\n");

function fail(code, message) {
  console.error(`gate2-tables: ${message}`);
  if (code === 2) console.error(USAGE);
  process.exit(code);
}

// The flags this gate reads, declared once so the shared parser binds a negative
// value to its option and refuses an unknown one (ISSUE-072). `fail(2, ...)` is
// still the refusal: it prints the usage block this gate carries.
const GATE2_OPTIONS = optionsOf([
  ['--out', 'string'],
  ['--flip', 'string'],
  ['--arm', 'string'],
  ['--harness', 'string'],
  ['--quiet', 'boolean'],
]);
const { values: GATE2 } = parseDevArgs(process.argv.slice(2), {
  options: GATE2_OPTIONS,
  refuse: message => fail(2, message),
});
const quiet = GATE2.quiet ?? false;
const outArg = GATE2.out ?? null;
const flip = GATE2.flip ?? null;
const flipArm = GATE2.arm ?? "both";
if (outArg === null) fail(2, "--out is required");
if (!["off", "on", "both"].includes(flipArm)) fail(2, `--arm must be off, on or both, got ${flipArm}`);

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const harnessArg = GATE2.harness ?? process.env.CREMATOR_SIM_HARNESS ?? null;
const harnessDir = harnessArg === null || harnessArg === ""
  ? path.join(REPO_ROOT, "scratchpad", "spike-008", "v4")
  : path.resolve(REPO_ROOT, harnessArg);

// The same resolution `lib/assets.mjs` uses: the env var is cwd-relative.
const DIST_OVERRIDE = process.env.CREMATOR_SIM_DIST;
const DIST_ROOT = DIST_OVERRIDE === undefined || DIST_OVERRIDE === ""
  ? path.join(REPO_ROOT, "packages", "core", "dist")
  : path.resolve(DIST_OVERRIDE);

/** Dynamic imports so a missing input is a named exit 2, not a stack trace. */
async function loadHarness() {
  const modules = {};
  for (const [key, relative] of [
    ["assets", "lib/assets.mjs"],
    ["build", "lib/prefix-build.mjs"],
    ["plan", "lib/prefix-plan.mjs"],
    ["bank", "lib/memory-bank.mjs"],
  ]) {
    const file = path.join(harnessDir, relative);
    try {
      modules[key] = await import(pathToFileURL(file).href);
    } catch (error) {
      fail(2, `the input harness at ${harnessDir} is not loadable: ${file}:`
        + ` ${error?.message ?? error} (pass --harness <dir> or set CREMATOR_SIM_HARNESS)`);
    }
  }
  for (const [key, names] of [
    ["assets", ["DIST_ROOT"]],
    ["build", ["renderPristineSegment"]],
    ["plan", ["loadBundle"]],
    ["bank", ["createMemoryBank"]],
  ]) {
    const absent = names.filter(name => modules[key][name] === undefined);
    if (absent.length > 0) {
      fail(2, `the harness module ${key} lacks: ${absent.join(", ")}`);
    }
  }
  return modules;
}

/** The shipped package entry: every recompute call below comes from here. */
async function loadShipped() {
  const entry = path.join(DIST_ROOT, "index.js");
  let module;
  try {
    module = await import(pathToFileURL(entry).href);
  } catch (error) {
    fail(2, `the shipped core entry ${entry} is not loadable: ${error?.message ?? error}`
      + " (build it, or pin a frozen copy with CREMATOR_SIM_DIST)");
  }
  const required = [
    "renderHistory", "receiptLine", "appliedSetAt", "epochsFor", "canonicalRanges", "sha256Sync",
  ];
  const absent = required.filter(name => typeof module[name] !== "function");
  if (absent.length > 0) {
    fail(2, `the shipped core entry ${entry} lacks: ${absent.join(", ")}`);
  }
  return module;
}

const harness = await loadHarness();
if (path.resolve(harness.assets.DIST_ROOT) !== DIST_ROOT) {
  fail(2, `the harness renders from ${harness.assets.DIST_ROOT} but the gate recomputes from`
    + ` ${DIST_ROOT}; both must follow CREMATOR_SIM_DIST`);
}
const { loadBundle } = harness.plan;
const { renderPristineSegment } = harness.build;
const { createMemoryBank } = harness.bank;
const {
  renderHistory, receiptLine, appliedSetAt, epochsFor, canonicalRanges, sha256Sync,
} = await loadShipped();

const outDir = path.isAbsolute(outArg) ? outArg : path.resolve(process.cwd(), outArg);
const summaryPath = path.join(outDir, "run-v4-tables-summary.json");
const rowsPath = path.join(outDir, "run-v4-tables.jsonl");
let summary;
let allRows;
try {
  summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  allRows = readFileSync(rowsPath, "utf8").split("\n")
    .map(line => line.trim()).filter(line => line !== "").map(line => JSON.parse(line));
} catch (error) {
  fail(2, `cannot read ${outDir}: ${error.message}`);
}
if (allRows.length === 0) fail(2, "run-v4-tables.jsonl has no rows");
if (summary?.tool !== "run-v4-full" || summary?.mode !== "dry") {
  fail(2, "the summary is not a dry run-v4-full artifact");
}
if (!Array.isArray(summary.epochs) || !Array.isArray(summary.sessions)) {
  fail(2, "the summary carries no epochs/sessions records");
}

// ---------------------------------------------------------------------------
// Inputs: the same manifest and conversation bytes the run recorded.

const manifestPath = summary.corpus?.manifest?.path;
const conversationPath = summary.corpus?.conversation?.path;
if (typeof manifestPath !== "string" || typeof conversationPath !== "string") {
  fail(2, "the summary names no corpus paths");
}
const fileSha = file => sha256Sync(readFileSync(file));
const manifestSha = fileSha(manifestPath);
const conversationSha = fileSha(conversationPath);
if (manifestSha !== summary.corpus.manifest.sha256) {
  fail(2, `manifest drifted: ${manifestSha} != recorded ${summary.corpus.manifest.sha256}`);
}
if (conversationSha !== summary.corpus.conversation.sha256) {
  fail(2, `conversation drifted: ${conversationSha} != recorded ${summary.corpus.conversation.sha256}`);
}

let bundle;
try {
  bundle = loadBundle({ manifestPath, conversationPath });
} catch (error) {
  fail(2, `input load failed: ${error.message}`);
}
const catalogue = bundle.catalogue;

// The gate must render from the same dist bytes the run recorded: a concurrent
// rebuild would otherwise let it vouch for a different renderer.
if (!Array.isArray(summary.dist?.modules) || summary.dist.modules.length === 0) {
  fail(2, "the summary records no dist module hashes");
}
for (const entry of summary.dist.modules) {
  let actual;
  try {
    actual = fileSha(path.join(DIST_ROOT, entry.name));
  } catch (error) {
    fail(2, `dist module ${entry.name} cannot be read: ${error.message}`);
  }
  if (actual !== entry.sha256) {
    fail(2, `dist module ${entry.name} drifted: ${actual} != recorded ${entry.sha256} (rebuild since the run?)`);
  }
}

// ---------------------------------------------------------------------------
// Row split. run-v4-full writes every OFF row, then every ON row.

const offRows = allRows.filter(row => row.arm === "off");
const onRows = allRows.filter(row => row.arm === "on");
if (offRows.length === 0 || onRows.length === 0) fail(2, "an arm has no rows");
if (offRows.length + onRows.length !== allRows.length) fail(2, "a row names neither arm");
if (offRows.length !== onRows.length) fail(2, "the arms carry a different table count");

// ---------------------------------------------------------------------------
// The frozen removal set, reconstructed from the OFF rows' own verdicts.
// Key order matters: the summary's sha256 covers the runner's JSON.stringify.

const frozenRaw = [];
for (const row of offRows) {
  if (!Number.isSafeInteger(row.lastTurn)) fail(2, `${row.tableId}: lastTurn is not an integer`);
  for (const verdict of row.verdicts ?? []) {
    if (verdict.action === "keepall") continue;
    const unit = catalogue.byUnit.get(verdict.unitId);
    if (unit === undefined) fail(2, `OFF row ${row.tableId} names unknown unit ${verdict.unitId}`);
    if (verdict.action === "forgetall") {
      frozenRaw.push({
        turn: row.lastTurn,
        unitId: verdict.unitId,
        wholeUnit: true,
        label: verdict.summary,
        path: unit.path,
      });
    } else if (verdict.action === "keeplines") {
      frozenRaw.push({
        turn: row.lastTurn,
        unitId: verdict.unitId,
        ranges: verdict.removedRanges,
        label: null,
        path: unit.path,
      });
    } else {
      fail(2, `OFF row ${row.tableId} carries unknown action ${String(verdict.action)}`);
    }
  }
}
const frozenSha = sha256Sync(Buffer.from(JSON.stringify(frozenRaw), "utf8"));
if (frozenSha !== summary.frozen?.sha256) {
  fail(2, `the frozen removal set cannot be reconstructed: ${frozenSha} != recorded ${summary.frozen?.sha256}`);
}
if (frozenRaw.length !== summary.frozen.decisions) {
  fail(2, `frozen decision count ${frozenRaw.length} != recorded ${summary.frozen.decisions}`);
}

/**
 * Resolves the raw freeze against the catalogue, with the product's own
 * `canonicalRanges` doing the range arithmetic. The lane's rules (unit
 * existence, the unit's own turn, wholeUnit explicitness, one decision per
 * unit) stay here; the canonical form is the shipped one.
 */
function resolveFrozen(raw, unitCatalogue) {
  const resolved = raw.map((decision, index) => {
    const where = `frozen[${index}]`;
    if (!Number.isSafeInteger(decision.turn) || decision.turn < 0) {
      fail(2, `${where}.turn must be a non-negative safe integer`);
    }
    const unit = unitCatalogue.byUnit.get(decision.unitId);
    if (unit === undefined) fail(2, `${where}: unknown unit ${String(decision.unitId)}`);
    if (unit.lineCount === 0) fail(2, `${where}: unit ${unit.unitId} has no body lines`);
    if (decision.turn < unit.turnIndex) {
      fail(2, `${where}: turn ${decision.turn} precedes the unit's own turn ${unit.turnIndex}`);
    }
    let ranges;
    let wholeUnit;
    if (decision.wholeUnit === true) {
      if (Array.isArray(decision.ranges) && decision.ranges.length > 0) {
        fail(2, `${where}: wholeUnit and ranges are exclusive`);
      }
      wholeUnit = true;
      ranges = [{ startLine: 1, endLineInclusive: unit.lineCount }];
    } else {
      if (!Array.isArray(decision.ranges) || decision.ranges.length === 0) {
        fail(2, `${where}: ranges must be a non-empty array, or set wholeUnit: true`);
      }
      let canonical;
      try {
        canonical = canonicalRanges(decision.ranges);
      } catch (error) {
        fail(2, `${where}: ${error.message}`);
      }
      const last = canonical[canonical.length - 1];
      if (last === undefined || last.endLineInclusive > unit.lineCount) {
        fail(2, `${where}: range ${last?.startLine}–${last?.endLineInclusive}`
          + ` exceeds ${unit.lineCount} lines`);
      }
      wholeUnit = canonical.length === 1 && canonical[0].startLine === 1
        && canonical[0].endLineInclusive === unit.lineCount;
      if (wholeUnit) {
        fail(2, `${where}: ranges cover every line; the freeze must say wholeUnit: true`);
      }
      ranges = canonical.map(range => ({ ...range }));
    }
    if (decision.label !== undefined && decision.label !== null && typeof decision.label !== "string") {
      fail(2, `${where}.label must be a string or null`);
    }
    const targetPath = decision.path === undefined ? unit.path : decision.path;
    if (typeof targetPath !== "string" || targetPath.length === 0) {
      fail(2, `${where}.path must be a non-empty string`);
    }
    return Object.freeze({
      turn: decision.turn,
      unitId: unit.unitId,
      sessionId: unit.sessionId,
      unitTurnIndex: unit.turnIndex,
      ranges: Object.freeze(ranges.map(range => Object.freeze({ ...range }))),
      wholeUnit,
      label: decision.label ?? null,
      path: targetPath,
      lineCount: unit.lineCount,
    });
  });
  const seen = new Set();
  for (const decision of resolved) {
    if (seen.has(decision.unitId)) fail(2, `two decisions target unit ${decision.unitId}`);
    seen.add(decision.unitId);
  }
  return Object.freeze(resolved);
}

const frozen = resolveFrozen(frozenRaw, catalogue);
// `appliedSetAt` filters on the decision turn only, so each session's prefix
// must be rebuilt from that session's own decisions, exactly as the runner did.
const frozenBySession = new Map();
for (const decision of frozen) {
  if (!frozenBySession.has(decision.sessionId)) frozenBySession.set(decision.sessionId, []);
  frozenBySession.get(decision.sessionId).push(decision);
}
const decisionByUnit = new Map(frozen.map(decision => [decision.unitId, decision]));

// ---------------------------------------------------------------------------
// The shipped receipts: the simulated bank mints the recall ids (unbound
// residue), the shipped `receiptLine` renders every receipt.

const ON_SESSION = "sim:tables-on";
const receiptByUnitId = new Map();
const preparedByUnitId = new Map();
try {
  const bank = await createMemoryBank({ sessionId: ON_SESSION, decisions: frozen });
  for (const unit of catalogue.ordered) {
    const decision = decisionByUnit.get(unit.unitId);
    if (decision === undefined) continue;
    // Archive order is catalogue order, exactly as the runner's builder did:
    // the bank's node counter is part of the recall id.
    const record = await bank.archive(unit.body, decision.ranges, {
      path: decision.path, label: decision.label,
    });
    const receipt = receiptLine({
      path: decision.path,
      ranges: record.lineRanges,
      label: decision.label,
      recallId: record.id,
    });
    preparedByUnitId.set(unit.unitId, Object.freeze({
      whole: record.lineRanges.length === 0,
      receipt,
      recallId: record.id,
    }));
    receiptByUnitId.set(unit.unitId, receipt);
  }
} catch (error) {
  fail(2, `the simulated bank could not mint the receipts: ${error.message}`);
}

// ---------------------------------------------------------------------------
// The shipped prefix renderer. `renderHistory` joins the turns; the receipt
// splice below is the named sim-side residue (no shipped renderer exists).

function renderUnitSegment(segment, unit, removed) {
  if (removed === undefined) return renderPristineSegment(segment);
  const entry = preparedByUnitId.get(unit.unitId);
  if (entry === undefined) {
    throw new Error(`applied removal for ${unit.unitId} has no prepared receipt`);
  }
  if (entry.whole) return entry.receipt;
  // One receipt in each removed gap; retained lines and trailing blanks keep
  // their bytes. The product's own rule (`renderRecords` -> `receiptLine`).
  const lines = [];
  let cursor = 0;
  for (const range of removed.ranges) {
    while (cursor < range.startLine - 1) {
      lines.push(segment.core[cursor]);
      cursor += 1;
    }
    lines.push(entry.receipt);
    cursor = range.endLineInclusive;
  }
  while (cursor < segment.core.length) {
    lines.push(segment.core[cursor]);
    cursor += 1;
  }
  return [segment.header, ...lines, ...segment.trailingBlanks].join("\n");
}

/** One turn block with one applied set. Pure in (block, applied). */
function renderTurnText(sessionIdWanted, turnIndex, applied) {
  const removed = applied instanceof Map
    ? applied
    : new Map((applied ?? []).map(entry => [entry.unitId, entry]));
  const block = catalogue.parsedTurns(sessionIdWanted).find(entry => entry.turnIndex === turnIndex);
  if (block === undefined) {
    throw new Error(`no pristine turn block for session ${sessionIdWanted} turn ${turnIndex}`);
  }
  let text = "";
  block.segments.forEach((bound, index) => {
    const rendered = bound.unit === null
      ? renderPristineSegment(bound.segment)
      : renderUnitSegment(bound.segment, bound.unit, removed.get(bound.unit.unitId));
    text = index === 0 ? rendered : `${text}\n${rendered}`;
  });
  return text;
}

/** The prefix bytes: the shipped `renderHistory` over the preceding turns. */
function renderPrefix(sessionIdWanted, turnIndex, applied) {
  const turns = [];
  for (const block of catalogue.parsedTurns(sessionIdWanted)) {
    if (block.turnIndex >= turnIndex) break;
    turns.push({ role: block.role, text: renderTurnText(sessionIdWanted, block.turnIndex, applied) });
  }
  return renderHistory(turns);
}

/** Byte-prefix predicate, the same rule the runner's chain checks use. */
function isBytePrefix(shorter, longer) {
  if (shorter.byteLength > longer.byteLength) return false;
  return shorter.subarray(0, shorter.byteLength).equals(longer.subarray(0, shorter.byteLength));
}

// ---------------------------------------------------------------------------
// Checks

const failures = new Map(); // class -> [messages]
let flipReddened = false;
function recordFailure(kind, message, detail = null) {
  if (!failures.has(kind)) failures.set(kind, []);
  failures.get(kind).push(message);
  if (detail?.isFlipTarget === true) flipReddened = true;
  console.log(`FAIL ${kind} ${message}`);
}
const failureCount = () => [...failures.values()].reduce((sum, list) => sum + list.length, 0);
const flipTargets = new Set();
if (flip !== null) {
  for (const row of allRows) {
    if (row.tableId !== flip) continue;
    if (flipArm !== "both" && row.arm !== flipArm) continue;
    flipTargets.add(`${row.arm}|${row.tableId}`);
  }
  if (flipTargets.size === 0) {
    fail(2, `--flip ${flip} names no table in arm ${flipArm}`);
  }
}

// ---------------------------------------------------------------------------
// (c) The epoch plan, re-derived by the shipped `epochsFor`. A row whose
// epochKey/epochIndex/epochBase the product's planner does not produce, or a
// summary epoch record that disagrees with it, is a red `epoch-plan`.
//
// The two checks below live in `./epoch-checks.mjs` so the multi-turn lane
// (ISSUE-035 item 10, chunk 5) reuses them instead of writing a second copy.
// Gate 2 remains where the checks are defined; this file's output is unchanged
// and its failure classes are still its own.

const ROWS_BY_ARM = { off: offRows, on: onRows };
const decisionsFor = (arm, sessionId) => (arm === "off"
  ? [] : frozenBySession.get(sessionId) ?? []);

const derivedEpochs = deriveEpochsByArm({
  rowsByArm: ROWS_BY_ARM, decisionsFor, epochsFor, recordFailure, fail,
});

const summaryEpochByKey = { off: new Map(), on: new Map() };
for (const record of summary.epochs) {
  if (record.arm !== "off" && record.arm !== "on") fail(2, "an epoch record names no arm");
  summaryEpochByKey[record.arm].set(record.epochKey, record);
}

checkEpochPlan({ rowsByArm: ROWS_BY_ARM, derivedEpochs, summaryEpochByKey, recordFailure });

/** arm -> Map(tableId -> {row, bytes, sha, rawBytes, rawSha}) */
const rebuiltByArm = { off: new Map(), on: new Map() };
let checked = 0;
let receiptRenderChecks = 0;
let receiptRenderMissing = 0;

// The rows' recorded applied sets, re-derived by the shipped `appliedSetAt` —
// the same check the multi-turn lane's removal stage imports.
checkAppliedSets({ rowsByArm: ROWS_BY_ARM, decisionsFor, appliedSetAt, sha256Sync, recordFailure });

for (const arm of ["off", "on"]) {
  const rows = arm === "off" ? offRows : onRows;
  for (const row of rows) {
    if (rebuiltByArm[arm].has(row.tableId)) {
      fail(2, `${arm} arm repeats table id ${row.tableId}`);
    }
    const applied = arm === "off"
      ? []
      : appliedSetAt(frozenBySession.get(row.sessionId) ?? [], row.lastTurn);

    let text;
    try {
      text = renderPrefix(row.sessionId, row.lastTurn + 1, applied);
    } catch (error) {
      recordFailure("recompute-render", `${arm} ${row.tableId}: ${error.message}`);
      continue;
    }
    const rawBytes = Buffer.from(text, "utf8");
    const rawSha = sha256Sync(rawBytes);

    // Receipts must render in the bytes the gate just built.
    if (arm === "on") {
      for (const entry of applied) {
        const receipt = receiptByUnitId.get(entry.unitId);
        if (receipt === undefined) {
          recordFailure("receipt-missing", `${row.tableId}: applied ${entry.unitId} has no shipped receipt`);
          receiptRenderMissing += 1;
          continue;
        }
        receiptRenderChecks += 1;
        if (!text.includes(receipt)) {
          recordFailure("receipt-missing", `${row.tableId}: the receipt for ${entry.unitId} does not render`);
          receiptRenderMissing += 1;
        }
      }
    }

    const isFlipTarget = flipTargets.has(`${arm}|${row.tableId}`);
    let bytes = rawBytes;
    if (isFlipTarget) {
      if (rawBytes.byteLength === 0) {
        recordFailure("flip-empty", `${arm} ${row.tableId} has an empty recomputed prefix to flip`);
        continue;
      }
      bytes = Buffer.from(rawBytes);
      bytes[0] ^= 0x01;
    }
    const sha = sha256Sync(bytes);
    checked += 1;
    if (sha !== row.prefixSha256) {
      recordFailure("recompute-sha",
        `${arm} ${row.tableId} recomputed ${sha.slice(0, 16)} != recorded ${String(row.prefixSha256).slice(0, 16)}`
        + (isFlipTarget ? " (flip target: expected)" : ""),
        { isFlipTarget });
    }
    if (rawBytes.byteLength !== row.prefixBytes) {
      recordFailure("recompute-bytes",
        `${arm} ${row.tableId} recomputed length ${rawBytes.byteLength} != recorded ${row.prefixBytes}`,
        { isFlipTarget });
    }
    rebuiltByArm[arm].set(row.tableId, { row, bytes, sha, rawBytes, rawSha });
  }
}

// ---------------------------------------------------------------------------
// (b) and (c): epochs on the EFFECTIVE bytes (flip included), read against the
// summary's own epoch records so a both-sides drift shows as one named class.

const epochRecords = new Map(); // `${arm}|${epochKey}` -> record
for (const record of summary.epochs) {
  epochRecords.set(`${record.arm}|${record.epochKey}`, record);
}
let epochPasses = 0;
for (const arm of ["off", "on"]) {
  const rows = arm === "off" ? offRows : onRows;
  const rebuilt = rebuiltByArm[arm];
  const groups = new Map(); // epochKey -> [tableId]
  for (const row of rows) {
    if (!groups.has(row.epochKey)) groups.set(row.epochKey, []);
    groups.get(row.epochKey).push(row.tableId);
  }
  for (const [epochKey, tableIds] of groups) {
    const record = epochRecords.get(`${arm}|${epochKey}`);
    if (record === undefined) {
      recordFailure("epoch-missing", `${arm} ${epochKey} has rows but no epoch record`);
      continue;
    }
    const before = failureCount();
    const first = rebuilt.get(tableIds[0]);
    const last = rebuilt.get(tableIds[tableIds.length - 1]);
    if (record.firstTableId !== tableIds[0]) {
      recordFailure("epoch-membership",
        `${arm} ${epochKey} first table ${tableIds[0]} != recorded ${record.firstTableId}`);
    }
    if (record.lastTableId !== tableIds[tableIds.length - 1]) {
      recordFailure("epoch-membership",
        `${arm} ${epochKey} last table ${tableIds[tableIds.length - 1]} != recorded ${record.lastTableId}`);
    }
    if (record.tableCount !== tableIds.length) {
      recordFailure("epoch-membership",
        `${arm} ${epochKey} table count ${tableIds.length} != recorded ${record.tableCount}`);
    }
    if (record.firstTurnIndex !== first?.row.lastTurn || record.lastTurnIndex !== last?.row.lastTurn) {
      recordFailure("epoch-membership",
        `${arm} ${epochKey} turns ${first?.row.lastTurn}..${last?.row.lastTurn}`
        + ` != recorded ${record.firstTurnIndex}..${record.lastTurnIndex}`);
    }
    if (record.basePrefixSha256 !== first?.sha) {
      recordFailure("epoch-base",
        `${arm} ${epochKey} first table ${first?.sha?.slice(0, 16)}`
        + ` != base ${String(record.basePrefixSha256).slice(0, 16)}`);
    }
    const appliedSetSha = sha256Sync(Buffer.from(record.appliedRemovalSet, "utf8"));
    if (appliedSetSha !== record.appliedRemovalSetSha256) {
      recordFailure("epoch-applied-set",
        `${arm} ${epochKey} applied-set sha ${appliedSetSha.slice(0, 16)}`
        + ` != recorded ${String(record.appliedRemovalSetSha256).slice(0, 16)}`);
    }
    for (const tableId of tableIds) {
      const entry = rebuilt.get(tableId);
      if (entry === undefined) continue;
      const applied = arm === "off"
        ? []
        : appliedSetAt(frozenBySession.get(entry.row.sessionId) ?? [], entry.row.lastTurn);
      if (JSON.stringify(applied) !== record.appliedRemovalSet) {
        recordFailure("epoch-applied-set",
          `${arm} ${tableId} sees an applied set that ${epochKey} does not record`);
      }
    }

    let previous = null;
    for (const tableId of tableIds) {
      const entry = rebuilt.get(tableId);
      if (entry === undefined) {
        previous = null;
        continue;
      }
      if (previous !== null) {
        if (previous.row.lastTurn === entry.row.lastTurn) {
          if (previous.sha !== entry.sha || !previous.bytes.equals(entry.bytes)) {
            recordFailure("same-turn-break",
              `${arm} ${tableId} and ${previous.row.tableId} share turn ${entry.row.lastTurn}`
              + " but their recomputed prefixes differ");
          }
        } else if (!isBytePrefix(previous.bytes, entry.bytes)) {
          recordFailure("no-extension",
            `${arm} ${tableId} (turn ${entry.row.lastTurn}) does not byte-extend`
            + ` ${previous.row.tableId} (turn ${previous.row.lastTurn}) in ${epochKey}`);
        }
      }
      previous = entry;
    }

    // The recorded same-turn groups must be byte-equal, on the rebuilt bytes.
    for (const group of record.sameTurnGroups ?? []) {
      const members = group.tableIds.map(tableId => rebuilt.get(tableId));
      for (let index = 1; index < members.length; index += 1) {
        const left = members[index - 1];
        const right = members[index];
        if (left === undefined || right === undefined) {
          recordFailure("same-turn-break", `${arm} ${epochKey} group ${group.turnIndex} names an unbuilt table`);
          continue;
        }
        if (!left.bytes.equals(right.bytes)) {
          recordFailure("same-turn-break",
            `${arm} ${epochKey} group turn ${group.turnIndex}: ${left.row.tableId} and`
            + ` ${right.row.tableId} are not byte-equal`);
        }
        if (left.row.lastTurn !== group.turnIndex || right.row.lastTurn !== group.turnIndex) {
          recordFailure("epoch-membership",
            `${arm} ${epochKey} group ${group.turnIndex} names a table of another turn`);
        }
      }
    }

    if (failureCount() === before) {
      epochPasses += 1;
      console.log(`PASS ${arm} ${epochKey} tables=${tableIds.length}`
        + ` turns=${record.firstTurnIndex}..${record.lastTurnIndex}`
        + ` base=${String(record.basePrefixSha256).slice(0, 16)}`
        + ` groups=${(record.sameTurnGroups ?? []).length}`);
    }
  }
}
for (const key of epochRecords.keys()) {
  const [arm, epochKey] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
  const rows = arm === "off" ? offRows : onRows;
  if (!rows.some(row => row.epochKey === epochKey)) {
    recordFailure("epoch-missing", `${arm} ${epochKey} is recorded but has no row`);
  }
}

// ---------------------------------------------------------------------------
// (e) arm pair: no visible removal means the ON prefix IS the OFF prefix.

for (const [position, offRow] of offRows.entries()) {
  const onRow = onRows[position];
  if (onRow === undefined) break;
  if (offRow.tableId !== onRow.tableId || offRow.sessionId !== onRow.sessionId) {
    recordFailure("arm-pair", `arm table order drifted at position ${position}`);
    continue;
  }
  const offEntry = rebuiltByArm.off.get(offRow.tableId);
  const onEntry = rebuiltByArm.on.get(onRow.tableId);
  if (offEntry === undefined || onEntry === undefined) continue;
  if ((onRow.applied?.unitIds?.length ?? 0) === 0 && !offEntry.rawBytes.equals(onEntry.rawBytes)) {
    recordFailure("arm-pair",
      `${offRow.tableId}: ON and OFF prefixes differ although no removal applies`);
  }
}

// ---------------------------------------------------------------------------
// Coverage and the summary's own receipt counts.

for (const arm of ["off", "on"]) {
  const rows = arm === "off" ? offRows : onRows;
  const records = summary.sessions.filter(record => record.arm === arm);
  const bySession = new Map();
  for (const row of rows) {
    bySession.set(row.sessionId, (bySession.get(row.sessionId) ?? 0) + 1);
  }
  if (records.length !== bySession.size) {
    recordFailure("session-coverage",
      `${arm} arm has ${bySession.size} sessions in rows but ${records.length} session records`);
  }
  for (const record of records) {
    const count = bySession.get(record.sessionId);
    if (count !== record.tables) {
      recordFailure("session-coverage",
        `${arm} ${record.sessionId}: ${count ?? 0} tables in rows != recorded ${record.tables}`);
    }
    if (record.calls !== rows.filter(row => row.sessionId === record.sessionId)
      .reduce((sum, row) => sum + row.tableUnits, 0)) {
      recordFailure("session-coverage", `${arm} ${record.sessionId}: unit count differs from the rows`);
    }
    if (record.epochs !== record.epochKeys.length) {
      recordFailure("session-coverage", `${arm} ${record.sessionId}: epoch count differs from its keys`);
    }
  }
  const unitTotal = rows.reduce((sum, row) => sum + row.tableUnits, 0);
  if (unitTotal !== summary.corpus?.selectedRows) {
    recordFailure("session-coverage",
      `${arm} arm judged ${unitTotal} units but the run selected ${summary.corpus?.selectedRows}`);
  }
}
if (summary.arms?.on?.receipts !== receiptByUnitId.size) {
  recordFailure("receipt-count",
    `the ON arm recorded ${summary.arms?.on?.receipts} receipts but the shipped renderer holds ${receiptByUnitId.size}`);
}
// receiptsRendered counts each applied removal per table: the same set the gate
// renders, so the two totals must agree.
const appliedTotal = onRows.reduce((sum, row) => sum + (row.applied?.unitIds?.length ?? 0), 0);
if (summary.arms?.on?.receiptsRendered !== appliedTotal) {
  recordFailure("receipt-count",
    `the ON arm rendered ${summary.arms?.on?.receiptsRendered} receipts but the rows apply ${appliedTotal}`);
}
if (receiptRenderChecks !== appliedTotal) {
  recordFailure("receipt-count",
    `${receiptRenderChecks} applied receipts were checked but ${appliedTotal} removals apply`);
}

// ---------------------------------------------------------------------------
// (f) non-vacuity and verdict.

if (flip !== null && !flipReddened) {
  recordFailure("non-vacuity", `--flip ${flip} left recompute-sha green: the gate cannot fail`);
}
if (flip !== null && !quiet) {
  const classes = [...failures.keys()].sort().join(", ");
  console.log(`gate2-tables: flip ${flip} (arm ${flipArm}) reddened: ${classes === "" ? "nothing" : classes}`);
}
if (!quiet) {
  console.log(`gate2-tables: shipped=${DIST_ROOT}`
    + " exports=renderHistory,receiptLine,appliedSetAt,epochsFor,canonicalRanges,sha256Sync");
  console.log(`gate2-tables: tables=${checked} epochs=${summary.epochs.length}`
    + ` receipts=${receiptByUnitId.size} receiptRenderChecks=${receiptRenderChecks}`
    + ` flip=${flip ?? "none"}`);
}
if (failures.size > 0) {
  const named = [...failures.entries()].map(([kind, list]) => `${kind}×${list.length}`).join(" ");
  console.error(`gate2-tables: RED — ${named}`);
  process.exit(1);
}
console.log(`gate2-tables: GREEN — ${checked} table prefixes recomputed and matched,`
  + ` ${epochPasses} epochs chained, ${receiptRenderChecks} applied receipts rendered`
  + (flip === null ? "" : `, flip ${flip} reddened recompute-sha as required`));
process.exit(0);
