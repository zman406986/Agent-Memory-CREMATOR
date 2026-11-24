#!/usr/bin/env node
/**
 * The ask-grammar A/B lane (ISSUE-221): the same inputs twice, once with the
 * product's `jsonl-20` ask and once with `jsonl-20-nokeepall`. ONLY the ask
 * grammar differs.
 *
 * Invocation:
 *
 *   node dev/sim/sim-ab-grammar.mjs --i-am-the-owner <the live lane's flags>
 *        --out <dir> [--json]
 *
 * Every flag the live lane accepts is forwarded unchanged (transcript, usage,
 * floor, mode, lanes/thresholds, trigger units, ask order, ask scope, transport,
 * host-pruner flag, the required token grant, and the optional ask ceiling and
 * kill timer).
 * The wrapper strips `--out` and `--json`, then runs `sim-batch-live.mjs`'s own
 * `main` twice: arm A with `--ask-grammar jsonl-20` and arm B with
 * `--ask-grammar jsonl-20-nokeepall`, each writing its normal artifacts under
 * `<out>/<grammar>/`. The only argument that differs between the two runs is
 * the grammar; the output directory differs only so the artifacts do not
 * overwrite each other.
 *
 * The wrapper then writes `<out>/ab-grammar.json` (`abReportOf`) and prints one
 * line per arm. The report names both arms and states, per arm, the decisions,
 * the freed and kept bytes, the refusals, the answer mix and the ask bytes. It
 * refuses (exit 2) if the arms read different inputs or if either arm's run
 * refused; a refused run still leaves its own partial artifact.
 *
 * `--transport stub` is the offline path: no socket, no key, no clock. A live
 * run reads the key and arms the kill timer exactly as the live lane does,
 * because it IS the live lane, run twice.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_DIR, main as runLiveMain, writeResultArtifact } from "./sim-batch-live.mjs";

export const AB_SCHEMA = "racoons-sim-ab-grammar/1";

/** The two arms, in report order: the product default first, the variant second. */
export const AB_GRAMMARS = Object.freeze(["jsonl-20", "jsonl-20-nokeepall"]);

/** The one sentence every report carries: the lane's own claim, stated. */
export const AB_STATEMENT =
  "Both arms replay the same transcript, depths, floor, trigger, batching, ask order,"
  + " ask scope and ask ceiling; only the ask grammar differs.";

const USAGE = [
  "usage: sim-ab-grammar.mjs --i-am-the-owner <the live lane's flags> --out <dir> [--json]",
  "",
  "Runs sim-batch-live.mjs twice with the same inputs: once with --ask-grammar",
  "jsonl-20 (the product default) and once with --ask-grammar jsonl-20-nokeepall.",
  "Every other live-lane flag is forwarded unchanged; --out is the A/B root, and",
  "each arm writes under <out>/<grammar>/. The report is <out>/ab-grammar.json.",
  "",
  "Example (offline):",
  "  node dev/sim/sim-ab-grammar.mjs --i-am-the-owner --transport stub",
  "    --ignore-host-prunes --allow-zero-reasoning --lanes 8 --token-grant 10000000",
  "    --transcript <session.v4.jsonl> --usage <result.json> --out scratchpad/ab",
].join("\n");

/** A named refusal with the wrapper's own exit path. */
export class SimAbGrammarRefusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "SimAbGrammarRefusal";
    this.code = code;
    this.exitCode = 2;
  }
}

function refuse(code, detail) {
  throw new SimAbGrammarRefusal(code, detail);
}

/**
 * The wrapper's arguments: `--out` is the A/B root and `--json` asks for the
 * report on stdout; everything else is forwarded. `--ask-grammar` belongs to
 * the lane, never the caller, so it refuses by name instead of being ignored.
 */
export function parseAbArgs(argv) {
  let out = null;
  let json = false;
  let help = false;
  const forwarded = [];
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at];
    if (token === "--out") {
      const value = argv[at + 1];
      if (value === undefined) refuse("sim-ab-grammar-args", "--out needs a directory");
      out = value;
      at += 1;
      continue;
    }
    if (token.startsWith("--out=")) {
      out = token.slice("--out=".length);
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--ask-grammar" || token.startsWith("--ask-grammar=")) {
      refuse("sim-ab-grammar-grammar-fixed",
        "the A/B lane sets --ask-grammar itself (jsonl-20 and jsonl-20-nokeepall);"
        + " drop it from the forwarded flags");
    }
    forwarded.push(token);
  }
  if (help) return { help: true, out, json, forwarded };
  if (out === null) out = path.join(LIVE_DIR, "ab-grammar");
  if (!forwarded.includes("--i-am-the-owner")) {
    refuse("sim-ab-grammar-owner-required",
      "--i-am-the-owner is required; nothing was read and no call was made");
  }
  return { help: false, out: path.resolve(out), json, forwarded };
}

/** The one JSON artifact a finished (or refused) live arm writes. */
export function readArmOutput(dir) {
  if (!readdirSync(dir, { withFileTypes: true }).some(entry => entry.isFile())) return null;
  const files = readdirSync(dir).filter(file => file.endsWith(".json"));
  if (files.length !== 1) {
    refuse("sim-ab-grammar-artifact",
      `${dir} holds ${String(files.length)} JSON artifact(s); a live arm writes one`);
  }
  return JSON.parse(readFileSync(path.join(dir, files[0]), "utf8"));
}

/** One arm's decisions, bytes, refusals, answer mix and ask bytes. */
export function abArmOf({ grammar, output = null, exitStatus = 0 }) {
  const refusedRun = output?.refused === true;
  const run = refusedRun ? (output.summary ?? {}) : (output ?? {});
  const records = Array.isArray(output?.records) ? output.records : [];
  const firstPassRecords = records.filter(record => record.kind !== "correction");
  const answerMix = { keepall: 0, keeplines: 0, forgetall: 0, forgetlines: 0, refused: 0 };
  for (const record of firstPassRecords) {
    for (const row of record.rows ?? []) {
      if (row.status !== "answered") answerMix.refused += 1;
      else if (Object.hasOwn(answerMix, row.action)) answerMix[row.action] += 1;
    }
  }
  const sumOf = key => firstPassRecords.reduce((sum, record) => sum + (record[key] ?? 0), 0);
  const correctionAskBytes = records
    .filter(record => record.kind === "correction")
    .reduce((sum, record) => sum + (record.correctionAskBytes ?? 0), 0);
  const inputCount = Number.isSafeInteger(run.eligibility?.total)
    ? run.eligibility.total
    : (Number.isSafeInteger(output?.eligible) ? output.eligible : null);
  const freedNet = run.bytesFreedByPolicy ?? 0;
  const eligibleBytes = run.eligibleBytes ?? null;
  return {
    grammar,
    exitStatus,
    refused: refusedRun,
    refusal: refusedRun ? (output.refusal ?? null) : null,
    input: abInputOf(output),
    inputCount,
    asks: run.asks ?? 0,
    triggers: run.triggers ?? 0,
    decisions: {
      keep: run.keep ?? 0,
      forget: run.forget ?? 0,
      keeplines: run.keeplines ?? 0,
      appliedForgets: run.appliedForgets ?? 0,
      refused: run.refused ?? 0,
      decidedRows: (run.keep ?? 0) + (run.forget ?? 0),
    },
    bytes: {
      eligible: eligibleBytes,
      freedNet,
      freedGross: run.bytesFreedGross ?? 0,
      kept: eligibleBytes === null ? null : eligibleBytes - freedNet,
    },
    refusals: {
      rows: run.refused ?? 0,
      rowClasses: run.rowRefusalClasses ?? {},
      sends: run.refusedSends ?? 0,
      sendClasses: run.refusalClasses ?? {},
      parseRefusedRows: run.parseRefusedRows ?? 0,
    },
    answerMix,
    askBytes: {
      askText: sumOf("askBytes"),
      promptContent: sumOf("promptBytes"),
      promptWire: sumOf("promptWireBytes"),
      correctionAsk: correctionAskBytes,
      peakWire: run.promptPeakWireBytes ?? 0,
      sends: firstPassRecords.length,
    },
  };
}

/**
 * The A/B report: both arms, the shared input, and the claim that only the
 * grammar differs. `inputCount` is the eligible population both arms read; a
 * mismatch (or an arm that refused before reading) is reported, never hidden.
 */
export function abReportOf({ arms, input = {} }) {
  const named = new Set(arms.map(arm => arm.grammar));
  for (const grammar of AB_GRAMMARS) {
    if (!named.has(grammar)) {
      refuse("sim-ab-grammar-arms",
        `the report needs both arms ${AB_GRAMMARS.join(" and ")}, got ${[...named].join(", ")}`);
    }
  }
  if (arms.length !== AB_GRAMMARS.length) {
    refuse("sim-ab-grammar-arms",
      `the report is exactly ${String(AB_GRAMMARS.length)} arms, got ${String(arms.length)}`);
  }
  const rows = AB_GRAMMARS.map(grammar => {
    const arm = arms.find(entry => entry.grammar === grammar);
    return abArmOf(arm);
  });
  const counts = rows.map(row => row.inputCount);
  const sameInputCount = counts.every(count => count !== null && count === counts[0]);
  const sameParameters = rows.every((row, at) =>
    at === 0 || JSON.stringify(row.input) === JSON.stringify(rows[0].input));
  return {
    schema: AB_SCHEMA,
    statement: AB_STATEMENT,
    onlyGrammarDiffers: sameInputCount && sameParameters,
    sameInputCount,
    inputCount: sameInputCount ? counts[0] : null,
    grammars: [...AB_GRAMMARS],
    input,
    arms: rows,
    diff: {
      keep: rows[1].decisions.keep - rows[0].decisions.keep,
      forget: rows[1].decisions.forget - rows[0].decisions.forget,
      refused: rows[1].decisions.refused - rows[0].decisions.refused,
      freedNet: rows[1].bytes.freedNet - rows[0].bytes.freedNet,
      kept: rows[1].bytes.kept === null || rows[0].bytes.kept === null
        ? null : rows[1].bytes.kept - rows[0].bytes.kept,
      promptWire: rows[1].askBytes.promptWire - rows[0].askBytes.promptWire,
    },
  };
}

/** The input fields both arm artifacts must agree on, read once per output. */
export function abInputOf(output) {
  return {
    transcript: output?.input?.transcript ?? null,
    transcriptSha256: output?.input?.transcriptSha256 ?? null,
    usage: output?.input?.usage ?? null,
    usageSha256: output?.input?.usageSha256 ?? null,
    floor: output?.eligibility?.floor ?? null,
    mode: output?.mode ?? null,
    laneSize: output?.laneSize ?? null,
    threshold: output?.threshold ?? null,
    thresholdUnits: output?.thresholdUnits ?? null,
    askOrder: output?.askOrder ?? null,
    askScope: output?.askScope ?? null,
    tokenGrant: output?.tokenGrant ?? null,
    askCeiling: output?.askCeiling ?? null,
  };
}

/** The human report: one line per arm, then the shared input line. */
export function abLineOf(report) {
  const lines = [
    `[ab] ${report.grammars.join(" vs ")}: only the ask grammar differs`,
    ...report.arms.map(arm =>
      `[ab] ${arm.grammar.padEnd(24)} asks=${String(arm.asks)}`
      + ` keep=${String(arm.decisions.keep)} forget=${String(arm.decisions.forget)}`
      + ` refused=${String(arm.decisions.refused)}`
      + ` freed=${String(arm.bytes.freedNet)} B kept=${String(arm.bytes.kept)} B`
      + ` answerMix=keepall:${String(arm.answerMix.keepall)}`
      + `,keeplines:${String(arm.answerMix.keeplines)}`
      + `,forgetall:${String(arm.answerMix.forgetall)}`
      + ` askBytes=${String(arm.askBytes.askText)}`
      + ` wire=${String(arm.askBytes.promptWire)}`
      + `${arm.refused ? ` REFUSED: ${arm.refusal}` : ""}`),
    `[ab] input ${String(report.inputCount)} eligible unit(s);`
      + ` sameInputCount=${String(report.sameInputCount)}`
      + ` onlyGrammarDiffers=${String(report.onlyGrammarDiffers)}`,
  ];
  return lines.join("\n");
}

/**
 * Run both arms through the live lane's own `main`, then write the report.
 * The forwarded flags are byte-identical; `--ask-grammar` and `--out` are the
 * only pieces this wrapper adds, and the out directory differs per arm so one
 * arm's evidence cannot overwrite the other's.
 */
export async function runAbMain(argv, { runLive = runLiveMain, writeArtifact = writeResultArtifact } = {}) {
  const opts = parseAbArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const arms = [];
  for (const grammar of AB_GRAMMARS) {
    const armDir = path.join(opts.out, grammar);
    mkdirSync(armDir, { recursive: true });
    const exitStatus = await runLive([
      ...opts.forwarded, "--ask-grammar", grammar, "--out", armDir,
    ]);
    arms.push({ grammar, exitStatus, output: readArmOutput(armDir) });
  }
  const report = abReportOf({
    arms,
    input: abInputOf(arms[0]?.output),
  });
  const target = path.join(opts.out, "ab-grammar.json");
  writeArtifact({ target, output: report });
  process.stdout.write(`${abLineOf(report)}\n`);
  process.stdout.write(`wrote ${target}\n`);
  if (opts.json === true) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return arms.every(arm => arm.exitStatus === 0) && report.onlyGrammarDiffers ? 0 : 2;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAbMain(process.argv.slice(2)).then(code => process.exit(code)).catch(error => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(Number.isSafeInteger(error?.exitCode) ? error.exitCode : 2);
  });
}
