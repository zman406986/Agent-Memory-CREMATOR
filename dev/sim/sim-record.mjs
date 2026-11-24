#!/usr/bin/env node
/**
 * ISSUE-059 T-1 — the record adapter: a `live-convert.mjs` output directory,
 * read as the moment list the sim lanes score.
 *
 * Usage:
 *   node dev/sim/sim-record.mjs --units <live-convert out dir> [--floor 1280]
 *        [--record-name <name>] [--ledger <ledger copy>] [--out <file>] [--json]
 *
 * A MOMENT is one over-floor landed result the converter wrote into
 * `live-units.jsonl`: `id` is the converter's own `unit:sha256:` id, `byteRange`
 * is the whole-result span that id was minted over (`mintUnitId` in the
 * converter), `unitSpan` is the shaped turn's surface seq span where one exists,
 * and `provenance` says which lane emitted the decision and through which seam.
 * Nothing is re-parsed here: every field is the converter's, re-expressed.
 *
 * WHY NO `racoons` AND NO `T1` LITERAL. A one-arm record (run B) joins nothing:
 * `live-join.json` holds `T1: 0`, and every unit is `T3`, because the tier is
 * join-defined and there is no second side. A reader keyed on
 * `unit.arm === "racoons" && unit.tier === "T1"` misses every moment of that
 * file. This adapter takes the lane from the record's own units and census
 * (whose names come from the manifest, not from here), carries `tier` verbatim,
 * and never filters on it: the join is a two-arm comparison, not a relevance
 * gate. On 040 the two-arm record yields 65 moments and the one-arm record
 * yields the same 65.
 *
 * PROVENANCE. The plan reads lane membership from the record, never from the
 * composition class: a `forgetlines` answer and a `keeplines` answer both
 * classify `forget-with-partials`, so a class-keyed reader would shelve the two
 * lanes together. Per moment:
 *
 *   lane          verbatim from the unit (`unit.arm`); the manifest's own name
 *   recordName    `--record-name`, defaulting to `lane`
 *   source        `<recordName>/entry-ask` when an ask decided the row — the
 *                 mount's appended ask carries a `source.kind` of that form
 *                 (`packages/adapters/dsh/src/journal-kinds.ts:40-45`); `null`
 *                 when no ask decided it (ask-failed-fail-open, or the engine's
 *                 at-rest proof burn). The converter's output does not carry the
 *                 plugin's `recordName`, so the record's arm name stands in
 *                 unless the caller states the real one.
 *   composition   verbatim: keepall | forget-with-partials | forget-all |
 *                 ask-failed-fail-open | null (a machinery removal has none)
 *   keepallVia    verbatim: journal-entry-apply | surface-rewind | null
 *   censoredClass verbatim: refused-ask | machinery-at-rest-removal | null
 *   recallId      the removal's recall id, when one exists
 *   ruleIds       the ledger's `application_removals.rule_id` rows for that
 *                 recall id, sorted — attached only when `--ledger` is given;
 *                 `ruleIdSource` says which case produced the value
 *                 (`ledger`, `no-ledger-row`, `no-ledger`, `no-removal`).
 *
 * FLOOR. A moment is a unit at or above the requested floor. The default is the
 * record's own floor (`census.floor`, cross-checked against `join.floor`). A
 * floor below 1280 is refused by name: that is this model's shipped floor
 * (`FLOOR_BYTES_BY_MODEL["deepseek-v4.1-flash-1017"]`, `packages/core/src/
 * config.ts:80`) and the fixture keeps sub-floor bodies as trimmed copies, so a
 * lower floor would invent a reading. A floor below the record's own floor is
 * refused as well: rows under it were never written, so the record cannot
 * answer that request.
 *
 * INTEGRITY, each a named refusal: a missing directory or input file, an
 * unreadable JSON/JSONL line, a missing or malformed unit id, a duplicate id, a
 * unit naming an arm the census does not carry, a unit under the record's own
 * floor, and a census/join floor disagreement. A record that fails one of these
 * is not scored partially.
 *
 * Deterministic and offline: no clock, no network, no transcript read, no
 * environment read.
 *
 * Exit: 0 = read; 2 = a usage error or a named refusal (`<code>: <detail>`).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { optionsOf, parseDevArgs } from "../shared/args.mjs";

const USAGE = [
  "usage: sim-record.mjs --units <live-convert out dir> [--floor 1280]",
  "                     [--record-name <name>] [--ledger <ledger copy>]",
  "                     [--out <file>] [--json]",
  "       --units        a live-convert.mjs output directory (live-units.jsonl,",
  "                      live-census.json, live-join.json)",
  "       --floor        the moment floor in landed bytes; default: the record's own",
  "       --record-name  the plugin recordName the ask source is named by;",
  "                      default: the record's own arm name",
  "       --ledger       a copied ledger.sqlite; its application_removals.rule_id",
  "                      rows are attached to the moments naming their recall id",
  "       --out          write the moment list as JSON (<name>.tmp then rename)",
  "       --json         print the moment list as JSON instead of the summary",
].join("\n");

/**
 * The lowest floor this adapter reads at: the 040 fixture's own floor and this
 * model's shipped floor. Kept equal to the converter's `FIXTURE_KEEP_FLOOR` so a
 * record and its reader can never disagree about what the floor means.
 */
export const MIN_FLOOR = 1280;

/** A refusal with the code the gate asserts on. */
export class SimRecordRefusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "SimRecordRefusal";
    this.code = code;
  }
}

export function refuse(code, detail) {
  throw new SimRecordRefusal(code, detail);
}

/** The argument map: the flag as written, the option it sets. */
const FLAGS = optionsOf([
  ["--units", "string"],
  ["--floor", "string"],
  ["--record-name", "string", "recordName"],
  ["--ledger", "string"],
  ["--out", "string"],
  ["--json", "boolean"],
]);

/**
 * The arguments, validated. A floor below `MIN_FLOOR` is refused HERE, before
 * any file is opened, so a bad floor can never read a record.
 */
export function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: FLAGS,
    refuse: message => refuse("usage", message),
    help: `${USAGE}\n`,
  });
  const opts = {
    units: values.units ?? null,
    floor: values.floor ?? null,
    recordName: values.recordName ?? null,
    ledger: values.ledger ?? null,
    out: values.out ?? null,
    json: values.json ?? false,
  };
  if (opts.units === null) refuse("usage", "--units is required");
  if (opts.floor !== null) {
    const floor = Number(opts.floor);
    if (!Number.isSafeInteger(floor) || floor <= 0) {
      refuse("usage", `--floor needs a positive integer, got ${opts.floor}`);
    }
    opts.floor = floor;
  }
  if (opts.floor !== null && opts.floor < MIN_FLOOR) {
    refuse("sim-record-floor-below-keep",
      `--floor ${opts.floor} is below ${MIN_FLOOR}; the fixture keeps sub-floor bodies`
      + " as trimmed copies, so scoring below it would invent a reading");
  }
  return opts;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return refuse("sim-record-unreadable", `${file}: ${error.message}`);
  }
}

/** One JSON object per line; a bad line is named with its number. */
function readUnitLines(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return refuse("sim-record-unreadable", `${file}: ${error.message}`);
  }
  const units = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    try {
      units.push(JSON.parse(line));
    } catch (error) {
      refuse("sim-record-unreadable", `${file} line ${index + 1}: ${error.message}`);
    }
  }
  return units;
}

/** The three files this adapter reads, as one record. */
export function loadRecord(dir) {
  if (!existsSync(dir)) refuse("sim-record-dir-absent", `${dir} does not exist`);
  const files = {
    units: path.join(dir, "live-units.jsonl"),
    census: path.join(dir, "live-census.json"),
    join: path.join(dir, "live-join.json"),
  };
  for (const file of Object.values(files)) {
    if (existsSync(file)) continue;
    refuse("sim-record-input-absent", `${file} is missing (live-convert writes`
      + " live-units.jsonl, live-census.json and live-join.json)");
  }
  return {
    dir,
    units: readUnitLines(files.units),
    census: readJson(files.census),
    join: readJson(files.join),
  };
}

/**
 * The record's own floor: `census.floor` and `join.floor` must both exist and
 * agree. One number, two statements — a disagreement means the sidecars are from
 * different runs, and no moment count is trustworthy.
 */
export function floorOf(record) {
  const censusFloor = record.census?.floor;
  const joinFloor = record.join?.floor;
  if (!Number.isSafeInteger(censusFloor) || !Number.isSafeInteger(joinFloor)) {
    refuse("sim-record-floor-absent",
      `census.floor=${String(censusFloor)} join.floor=${String(joinFloor)};`
      + " both must be integers");
  }
  if (censusFloor !== joinFloor) {
    refuse("sim-record-floor-disagreement",
      `census.floor=${censusFloor} but join.floor=${joinFloor}; the sidecars are not one run`);
  }
  return censusFloor;
}

/**
 * The ledger's rule ids per recall id. `application_removals` is the table the
 * engine writes one row per applied removal, `rule_id` naming the rule that
 * planned it; this is a read, never a guess.
 */
export function readLedgerIndex(file) {
  if (!existsSync(file)) refuse("sim-record-ledger-absent", `${file} does not exist`);
  let rows;
  try {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      rows = db.prepare("SELECT recall_id AS recallId, rule_id AS ruleId,"
        + " operation_kind AS kind FROM application_removals").all();
    } finally {
      db.close();
    }
  } catch (error) {
    return refuse("sim-record-ledger-unreadable", `${file}: ${error.message}`);
  }
  const index = new Map();
  for (const row of rows) {
    const recallId = String(row.recallId);
    const entry = index.get(recallId) ?? { ruleIds: [], kinds: [] };
    if (!entry.ruleIds.includes(String(row.ruleId))) entry.ruleIds.push(String(row.ruleId));
    if (!entry.kinds.includes(String(row.kind))) entry.kinds.push(String(row.kind));
    index.set(recallId, entry);
  }
  for (const entry of index.values()) {
    entry.ruleIds.sort();
    entry.kinds.sort();
  }
  return index;
}

/**
 * One unit's decision provenance, keyed on the record's own fields. `lane` is
 * the unit's arm as written; `source` is the ask seam that decided it, built
 * from `recordName` (the record does not carry the plugin's name), and null when
 * no ask decided the row.
 */
export function provenanceOf(unit, { recordName = null, ledgerIndex = null } = {}) {
  const lane = unit.arm;
  const name = recordName ?? lane;
  const machinery = unit.censoredClass === "machinery-at-rest-removal";
  const decided = !machinery && unit.composition !== null
    && unit.composition !== "ask-failed-fail-open";
  const recallId = unit.recallId ?? unit.atRest?.recallId ?? null;
  const ledgerRow = recallId === null || ledgerIndex === null
    ? null : ledgerIndex.get(recallId) ?? null;
  const ruleIds = recallId === null ? null : ledgerRow?.ruleIds ?? (ledgerIndex === null ? null : []);
  const ruleIdSource = recallId === null ? "no-removal"
    : ledgerIndex === null ? "no-ledger"
      : ledgerRow === null ? "no-ledger-row" : "ledger";
  return {
    lane,
    recordName: name,
    source: decided ? `${name}/entry-ask` : null,
    composition: unit.composition ?? null,
    keepallVia: unit.keepallVia ?? null,
    censoredClass: unit.censoredClass ?? null,
    recallId,
    ruleIds,
    ruleIdSource,
  };
}

/**
 * The moment list: every unit at or above the requested floor, in seq order,
 * each carrying its id, its byte span and its provenance. The units file already
 * holds only over-floor rows for the record's own floor; a requested floor above
 * it narrows the list, a requested floor below it is refused.
 */
export function momentsOf(record, opts = {}) {
  const recordFloor = floorOf(record);
  const floor = opts.floor ?? recordFloor;
  if (!Number.isSafeInteger(floor) || floor <= 0) {
    refuse("usage", `floor needs a positive integer, got ${String(floor)}`);
  }
  if (floor < MIN_FLOOR) {
    refuse("sim-record-floor-below-keep",
      `${floor} is below ${MIN_FLOOR}; the fixture keeps sub-floor bodies as trimmed copies`);
  }
  if (floor < recordFloor) {
    refuse("sim-record-floor-below-record",
      `${floor} is below the record's own floor ${recordFloor}; rows under it were never`
      + " written, so this record cannot answer it");
  }
  const arms = record.census?.arms ?? {};
  const armNames = Object.keys(arms);
  if (armNames.length === 0) refuse("sim-record-no-arms", `${record.dir}: the census names no arm`);

  const seen = new Set();
  const moments = [];
  for (const unit of record.units) {
    if (typeof unit.unitId !== "string" || !unit.unitId.startsWith("unit:sha256:")) {
      refuse("sim-record-unit-id-missing",
        `seq ${String(unit.seq)} carries no unit:sha256: id`);
    }
    if (!armNames.includes(unit.arm)) {
      refuse("sim-record-arm-unknown",
        `seq ${String(unit.seq)} names arm ${String(unit.arm)}, which the census does not carry`);
    }
    if (!Number.isSafeInteger(unit.bytes) || unit.bytes < recordFloor) {
      refuse("sim-record-below-record-floor",
        `seq ${String(unit.seq)} is ${String(unit.bytes)} bytes, under the record's floor`
        + ` ${recordFloor}`);
    }
    if (seen.has(unit.unitId)) {
      refuse("sim-record-duplicate-unit", `${unit.unitId} appears twice`);
    }
    seen.add(unit.unitId);
    if (unit.bytes < floor) continue;
    const spanStart = unit.spanStart ?? null;
    const spanEnd = unit.spanEnd ?? null;
    moments.push({
      id: unit.unitId,
      lane: unit.arm,
      session: arms[unit.arm]?.sessionId ?? null,
      seq: unit.seq ?? null,
      step: unit.step ?? null,
      callId: unit.callId ?? null,
      tool: unit.tool ?? null,
      path: unit.path ?? null,
      bytes: unit.bytes,
      byteRange: { startByte: 0, endByteExclusive: unit.bytes },
      unitSpan: spanStart === null || spanEnd === null
        ? null : { startSeq: spanStart, endSeq: spanEnd },
      original: {
        sha256: unit.rawSha256 ?? null,
        normKey: unit.normKey ?? null,
        substitutions: unit.substitutions ?? null,
      },
      dropped: unit.droppedBytes ?? null,
      kept: unit.keptBytes ?? null,
      marker: { gaps: unit.markerCount ?? unit.gaps ?? 0, bytes: unit.markerBytes ?? 0 },
      summaryBytes: unit.summaryBytes ?? 0,
      framingBytes: unit.framingBytes ?? null,
      recallId: unit.recallId ?? null,
      provenance: provenanceOf(unit, {
        recordName: opts.recordName ?? null,
        ledgerIndex: opts.ledgerIndex ?? null,
      }),
      record: {
        tier: unit.tier ?? null,
        composition: unit.composition ?? null,
        keepallVia: unit.keepallVia ?? null,
        censoredClass: unit.censoredClass ?? null,
        atRest: unit.atRest ?? null,
      },
    });
  }
  return moments.sort((left, right) => (left.seq - right.seq) || left.id.localeCompare(right.id));
}

/** The human summary: counts, no ratios, no number that is not a count. */
export function summaryOf(moments, { dir, floor, recordFloor, filtered }) {
  const countBy = keyOf => moments.reduce((totals, moment) => {
    const key = keyOf(moment);
    totals[key] = (totals[key] ?? 0) + 1;
    return totals;
  }, {});
  const lanes = countBy(moment => moment.lane);
  const sources = countBy(moment => moment.provenance.source ?? "no-ask");
  const compositions = countBy(moment =>
    moment.provenance.composition ?? moment.provenance.censoredClass ?? "none");
  const shaped = moments.filter(moment => moment.unitSpan !== null).length;
  const dropped = moments.reduce((total, moment) => total + (moment.dropped ?? 0), 0);
  return [
    "sim-record",
    `  units        ${dir}`,
    `  floor        ${floor} (record ${recordFloor})`,
    `  lanes        ${Object.entries(lanes).map(([lane, count]) => `${lane}:${count}`).join(" ")}`,
    `  moments      ${moments.length}`,
    `  filtered     ${filtered} under the requested floor`,
    `  shaped       ${shaped} carrying a shaped turn, ${moments.length - shaped} whole-result`,
    `  dropped      Σ ${dropped} bytes`,
    `  provenance   ${Object.entries(sources).map(([source, count]) => `${source}=${count}`).join(" ")}`,
    `  compositions ${Object.entries(compositions).map(([name, count]) => `${name}=${count}`).join(" ")}`,
  ].join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = path.resolve(process.cwd(), opts.units);
  const record = loadRecord(dir);
  const recordFloor = floorOf(record);
  const ledgerIndex = opts.ledger === null
    ? null : readLedgerIndex(path.resolve(process.cwd(), opts.ledger));
  const moments = momentsOf(record, {
    floor: opts.floor ?? recordFloor,
    recordName: opts.recordName,
    ledgerIndex,
  });
  const floor = opts.floor ?? recordFloor;
  if (opts.out !== null) {
    const target = path.resolve(process.cwd(), opts.out);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(`${target}.tmp`, `${JSON.stringify(moments, null, 2)}\n`);
    renameSync(`${target}.tmp`, target);
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(moments, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${summaryOf(moments, {
    dir, floor, recordFloor, filtered: record.units.length - moments.length,
  })}\n`);
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
