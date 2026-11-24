#!/usr/bin/env node
/**
 * ISSUE-061 T-9 — the lane F live harness's gate. Offline: the only socket in
 * this file is a loopback listener that must receive ZERO connections, and the
 * live pass runs against a local producer module, never the a6 route.
 *
 * Run: node --test dev/sim/sim-live.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_KILL_MS, LIVE_ENV, MODEL, OWNER_FLAG, PROVIDER, VARIANT,
  actionOf, askInstruction, buildAskRequest, gateLive, laneMoments, parseArgs, planOf, tau,
} from "./sim-live.mjs";
import { indexTranscript, readTranscript } from "./gate3-live-chain.mjs";
import { load as loadPartial, score } from "./sim-compare.mjs";
import { renderLane } from "./sim-render.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = path.join(HERE, "sim-live.mjs");
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CONVERTER = path.join(REPO_ROOT, "dev", "bench", "multiturn", "live-convert.mjs");
const FIXTURE = path.join(REPO_ROOT, "dev", "bench", "fixtures", "sim");
const MANIFEST = path.join(FIXTURE, "manifest.json");
const TRANSCRIPT = path.join(FIXTURE, "sim.session.v4.jsonl");

function freshDir() {
  return mkdtempSync(path.join(tmpdir(), "racoons-sim-live-"));
}

/** The converter over the sim fixture into a fresh dir; returns the out dir. */
function convert(out) {
  const result = spawnSync(process.execPath, [CONVERTER, "--manifest", MANIFEST, "--out", out],
    { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return out;
}

/** The child env with the arming flag removed, so no test inherits a live pass. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env[LIVE_ENV];
  delete env.A6_API_KEY;
  delete env.CREMATOR_SIM_REAL;
  delete env.BENCH_REAL_API;
  return { ...env, ...extra };
}

function run(args, { env = cleanEnv(), timeout = 30_000 } = {}) {
  // Every spawn acknowledges the LEGACY lane (twelfth audit item 10): the
  // harness refuses without `--legacy-lane`.
  return spawnSync(process.execPath, [SCRIPT, ...args, "--legacy-lane"],
    { encoding: "utf8", env, timeout });
}

/** The CLI started asynchronously, so a slow producer cannot block the test. */
function runAsync(args, { env = cleanEnv() } = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args, "--legacy-lane"],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  return new Promise(resolve => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const readLines = file => readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);

// ---- legacy lane ----------------------------------------------------------

test("the legacy lane refuses unless --legacy-lane acknowledges it", () => {
  // Twelfth audit item 10: this harness is not the sim test. An invocation
  // without the acknowledgement exits 2 and names the file's state, so a
  // silent run can never be read as a sim measurement.
  const result = spawnSync(process.execPath,
    [SCRIPT, "--units", "whatever", "--transcript", "whatever.jsonl"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /sim-live-legacy-lane/);
  assert.match(result.stderr, /LEGACY lane, not the sim test/);
});

// ---- the cost arithmetic, §3.7's formula ----------------------------------

test("tau and askInstruction are the plan's own formulas", () => {
  assert.equal(tau(0), 0);
  assert.equal(tau(1), 1);
  assert.equal(tau(4), 1);
  assert.equal(tau(2594), 649);
  // A(N) = 300 + 12·⌊N/100⌋
  assert.equal(askInstruction(0), 300);
  assert.equal(askInstruction(99), 300);
  assert.equal(askInstruction(100), 312);
  assert.equal(askInstruction(250), 324);
  assert.equal(askInstruction(41), 300);
});

// ---- --plan: every moment, the chain, two numbers, exit 0, no socket ------

test("--plan prints every moment, the prefix chain and two numbers, and opens no socket", async () => {
  const root = freshDir();
  let connections = 0;
  const server = createServer((_request, response) => { connections += 1; response.end("no"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const units = convert(path.join(root, "out"));
    const result = run(["--units", units, "--transcript", TRANSCRIPT], {
      env: cleanEnv({ SIM_LIVE_BASE_URL: `http://127.0.0.1:${port}/v1` }),
    });
    assert.equal(result.status, 0, result.stderr);
    const text = result.stdout;
    // Every moment, by its converter unit id, in the output.
    const unitsRows = readFileSync(path.join(units, "live-units.jsonl"), "utf8")
      .split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(unitsRows.length, 7);
    for (const unit of unitsRows) assert.ok(text.includes(unit.unitId), unit.unitId);
    // The prefix-hash chain: the pristine lane's own steps, hashes printed.
    assert.match(text, /chain/);
    assert.equal((text.match(/[0-9a-f]{64}/g) ?? []).length >= 8, true);
    // The two numbers, each named, never summed. `main` is Σ τ over the FED
    // prefix — every append, sub-floor included — so it is read from the plan
    // rather than pinned to the unit-only render's smaller total.
    const plan = planOf(parseArgs(["--units", units, "--transcript", TRANSCRIPT]));
    assert.match(text, new RegExp(`\\n\\s+main\\s+${plan.cost.main}\\s`));
    assert.match(text, /\n\s+asks\s+2100\s/);
    assert.match(text, /300·7 \+ 12·0/);
    // The fed prefix is wider than the ask list: the fixture carries an append
    // under the 1280-byte floor, and the model saw it.
    assert.ok(plan.chain.at(-1).turns > plan.moments.length);
    // The launch line carries the grant and the §7(b) ceiling.
    assert.match(text, new RegExp(`--token-grant ${plan.cost.main}`));
    assert.match(text, /--ask-ceiling 2100/);
    assert.match(text, new RegExp(`${LIVE_ENV}=1`));
    assert.match(text, /--kill-ms 7200000/);
    assert.equal(connections, 0, "plan mode opened a socket");
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("--plan is deterministic and its numbers re-derive from the printed rows", () => {
  const root = freshDir();
  try {
    const units = convert(path.join(root, "out"));
    const args = ["--units", units, "--transcript", TRANSCRIPT, "--plan"];
    const first = run(args);
    const second = run(args);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, second.stdout, "plan output moved between two identical runs");
    const plan = planOf(parseArgs(["--units", units, "--transcript", TRANSCRIPT]));
    assert.equal(plan.moments.length, 7);
    const main = plan.moments.reduce((total, row) => total + row.prefixTokens, 0);
    const asks = plan.moments.reduce((total, row) => total + row.askInstruction, 0);
    assert.equal(plan.cost.main, main);
    assert.equal(plan.cost.asks, asks);
    // Displayed main means per-moment ceil(bytes/4): the sum of the rows, never a
    // per-term division of one total.
    for (const row of plan.moments) assert.equal(row.prefixTokens, Math.ceil(row.prefixBytes / 4));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("the ask request is lane F's forgetlines contract on the a6 route, built and never sent", () => {
  const root = freshDir();
  try {
    const units = convert(path.join(root, "out"));
    const { moments, askRows } = laneMoments({ units, transcript: TRANSCRIPT });
    assert.equal(askRows, 0, "the sim census carries no ask usage row");
    const rendered = renderLane({ lane: "racoons", moments, decisions: [] });
    const request = buildAskRequest(moments[0], rendered);
    assert.equal(request.provider, PROVIDER);
    assert.equal(request.model, MODEL);
    assert.match(request.askText, /forgetlines/);
    assert.doesNotMatch(request.askText, /keeplines/);
    assert.equal(request.body.model, MODEL);
    assert.equal(request.body.messages.at(-1).content, request.askText);
    // The prefix turns carry the landed bodies, and the ask rides last.
    assert.ok(request.body.messages.length >= 2);
    assert.equal(request.body.messages[0].role, "user");
    assert.match(request.requestSha256, /^[0-9a-f]{64}$/);
    assert.equal(rendered.moments, 7);
    // A reply is read by the product's own grammar, and an unreadable one is null.
    assert.equal(actionOf('{"forgetlines":[[1,1],"stale"]}'), "forgetlines");
    assert.equal(actionOf('{"keepall":true}'), "keepall");
    assert.equal(actionOf("not an answer"), null);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---- --live: owner-gated, exit 2 ------------------------------------------

test("--live without the env flag and the owner flag exits 2 and names the gate", () => {
  const root = freshDir();
  try {
    const units = convert(path.join(root, "out"));
    const base = ["--live", "--units", units, "--transcript", TRANSCRIPT,
      "--token-grant", "1000", "--ask-ceiling", "1000", "--out", path.join(root, "p.jsonl")];
    for (const [label, args, env] of [
      ["neither", base, cleanEnv()],
      ["owner flag only", [...base, OWNER_FLAG], cleanEnv()],
      ["env only", base, cleanEnv({ [LIVE_ENV]: "1" })],
      ["env set to something else", [...base, OWNER_FLAG], cleanEnv({ [LIVE_ENV]: "true" })],
    ]) {
      const result = run(args, { env });
      assert.equal(result.status, 2, `${label}: expected exit 2`);
      assert.match(result.stderr, /sim-live-owner-gated/);
      assert.match(result.stderr, new RegExp(LIVE_ENV));
      assert.match(result.stderr, /i-am-the-owner/);
      assert.equal(existsSync(path.join(root, "p.jsonl")), false, `${label}: wrote a partial file`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("--live with both flags still refuses without the grant, the ceiling or the out file", () => {
  const root = freshDir();
  try {
    const units = convert(path.join(root, "out"));
    const armed = { [LIVE_ENV]: "1" };
    const out = path.join(root, "p.jsonl");
    const base = ["--live", OWNER_FLAG, "--units", units, "--transcript", TRANSCRIPT];
    const cases = [
      ["sim-live-grant-absent", [...base, "--ask-ceiling", "1000", "--out", out]],
      ["sim-live-ceiling-absent", [...base, "--token-grant", "1000", "--out", out]],
      ["sim-live-out-absent", [...base, "--token-grant", "1000", "--ask-ceiling", "1000"]],
    ];
    for (const [code, args] of cases) {
      const result = run(args, { env: cleanEnv(armed) });
      assert.equal(result.status, 2, code);
      assert.match(result.stderr, new RegExp(code));
    }
    assert.equal(gateLive({ owner: true, tokenGrant: 1, askCeiling: 1, out: "x" },
      { [LIVE_ENV]: "1" }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---- the kill timer: mocked slow producer, exit 124, partial file ----

test("a kill timer on a mocked slow producer exits 124 and keeps the partial file", async () => {
  const root = freshDir();
  try {
    const units = convert(path.join(root, "out"));
    // The producer answers the first moment, then hangs past the box. No socket:
    // the seam is a module, not an endpoint.
    const producer = path.join(root, "slow.mjs");
    writeFileSync(producer, [
      "export async function ask({ index, signal }) {",
      "  if (index > 0) {",
      "    await new Promise((resolve, reject) => {",
      "      const timer = setTimeout(resolve, 600000);",
      "      signal?.addEventListener('abort', () => {",
      "        clearTimeout(timer); reject(new Error('aborted by the kill box'));",
      "      }, { once: true });",
      "    });",
      "  }",
      "  return { text: '{\"forgetlines\":[[1,1],\"stale header line\"]}' };",
      "}",
    ].join("\n"));
    const out = path.join(root, "partial.jsonl");
    const started = Date.now();
    const result = await runAsync([
      "--live", OWNER_FLAG, "--units", units, "--transcript", TRANSCRIPT,
      "--kill-ms", "2000", "--token-grant", "100000", "--ask-ceiling", "100000",
      "--out", out, "--producer", producer,
    ], { env: cleanEnv({ [LIVE_ENV]: "1" }) });
    const elapsed = Date.now() - started;
    assert.equal(result.code, 124, result.stderr);
    assert.ok(elapsed >= 1_900, `the box fired early (${elapsed} ms)`);
    assert.ok(elapsed < 30_000, `the box fired late (${elapsed} ms)`);
    assert.equal(existsSync(out), true, "no partial file");
    const lines = readLines(out);
    assert.equal(lines[0].kind, "start");
    assert.equal(lines[0].killMs, 2000);
    assert.equal(lines[0].variant, VARIANT);
    // The first moment completed and was flushed BEFORE the kill.
    const answers = lines.filter(line => line.kind === "answer");
    assert.equal(answers.length, 1);
    assert.equal(answers[0].status, "answered");
    assert.match(answers[0].answerSha256, /^[0-9a-f]{64}$/);
    const stop = lines.at(-1);
    assert.equal(stop.kind, "stop");
    assert.equal(stop.reason, "kill-timer");
    assert.equal(stop.completed, 1);
    // A partial file is a PARTIAL: the remaining moments never wrote a line.
    assert.equal(lines.filter(line => line.kind === "answer").length < 7, true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a fast kill timer fires before the first answer, and still writes the partial file", async () => {
  const root = freshDir();
  try {
    const units = convert(path.join(root, "out"));
    const producer = path.join(root, "hang.mjs");
    writeFileSync(producer, [
      "export async function ask({ signal }) {",
      "  await new Promise((resolve, reject) => {",
      "    const timer = setTimeout(resolve, 600000);",
      "    signal?.addEventListener('abort', () => {",
      "      clearTimeout(timer); reject(new Error('aborted by the kill box'));",
      "    }, { once: true });",
      "  });",
      "  return { text: '{\"keepall\":true}' };",
      "}",
    ].join("\n"));
    const out = path.join(root, "partial.jsonl");
    const result = await runAsync([
      "--live", OWNER_FLAG, "--units", units, "--transcript", TRANSCRIPT,
      "--kill-ms", "250", "--token-grant", "100000", "--ask-ceiling", "100000",
      "--out", out, "--producer", producer,
    ], { env: cleanEnv({ [LIVE_ENV]: "1" }) });
    assert.equal(result.code, 124, result.stderr);
    const lines = readLines(out);
    assert.equal(lines[0].kind, "start");
    assert.equal(lines.at(-1).kind, "stop");
    assert.equal(lines.at(-1).reason, "kill-timer");
    assert.equal(lines.at(-1).completed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---- §7(b): the ask ceiling stops the pass and names the unjudged ---------

test("a reached ask ceiling exits 1 and prints the rest as lane-f-unjudged", async () => {
  const root = freshDir();
  try {
    const units = convert(path.join(root, "out"));
    const producer = path.join(root, "fast.mjs");
    writeFileSync(producer,
      "export async function ask() { return { text: '{\"keepall\":true}' }; }\n");
    const out = path.join(root, "partial.jsonl");
    // The ceiling is the plan's own arithmetic: enough for the first two asks
    // (instruction + that moment's prefix) and one token short of the third.
    const plan = planOf(parseArgs(["--units", units, "--transcript", TRANSCRIPT]));
    const costOf = row => row.askInstruction + row.prefixTokens;
    const allowed = plan.moments.slice(0, 2).map(costOf);
    const ceiling = allowed[0] + allowed[1];
    const result = await runAsync([
      "--live", OWNER_FLAG, "--units", units, "--transcript", TRANSCRIPT,
      "--kill-ms", "60000", "--token-grant", "100000", "--ask-ceiling", String(ceiling),
      "--out", out, "--producer", producer,
    ], { env: cleanEnv({ [LIVE_ENV]: "1" }) });
    assert.equal(result.code, 1, result.stderr);
    const lines = readLines(out);
    const stop = lines.at(-1);
    assert.equal(stop.kind, "stop");
    assert.equal(stop.reason, "ask-ceiling");
    assert.ok(Array.isArray(stop.unjudged) && stop.unjudged.length > 0);
    assert.equal(lines.filter(line => line.kind === "answer").length, 2);
    assert.equal(stop.completed, 2);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---- the row the live pass writes is the row the scorer reads ---------------

test("an answer row carries original and step, so sim-compare scores it uncensored", async () => {
  const root = freshDir();
  try {
    const units = convert(path.join(root, "out"));
    const producer = path.join(root, "fast.mjs");
    writeFileSync(producer, "export async function ask() {\n"
      + "  return { text: JSON.stringify({ forgetlines: [[1, 2], \"stale header lines\"] }),\n"
      + "    usage: { prompt_tokens: 700, completion_tokens: 30 } };\n"
      + "}\n");
    const out = path.join(root, "partial.jsonl");
    const result = await runAsync([
      "--live", OWNER_FLAG, "--units", units, "--transcript", TRANSCRIPT,
      "--kill-ms", "60000", "--token-grant", "1000000", "--ask-ceiling", "1000000",
      "--out", out, "--producer", producer,
    ], { env: cleanEnv({ [LIVE_ENV]: "1" }) });
    assert.equal(result.code, 0, result.stderr);
    // The pre-launch defect: `original` was never written, so every lane scored
    // `original-body-absent` and the winner rule could not be computed at all.
    const loaded = loadPartial(out);
    assert.equal(loaded.censored, null);
    for (const row of loaded.rows) {
      assert.equal(typeof row.original, "string");
      assert.equal(Number.isSafeInteger(row.step), true);
    }
    const lane = score(loaded, "f");
    assert.equal(lane.censored, null);
    assert.equal(lane.answered, 7);
    assert.ok(lane.dropped > 0, "the post-guard reading is a real byte count");
    assert.equal(lane.spend.billed, 730 * 7);
    // Stage rows line up across lanes because `step` rides on the row.
    assert.deepEqual(lane.stages.map(stage => stage.step),
      [1, 3, 5, 7, 9, 11, 13]);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a lane where every ask refuses exits 3 and names the dead pass", async () => {
  const root = freshDir();
  try {
    const units = convert(path.join(root, "out"));
    const producer = path.join(root, "dead.mjs");
    writeFileSync(producer,
      "export async function ask() { throw new Error('401 unauthorized'); }\n");
    const out = path.join(root, "partial.jsonl");
    const result = await runAsync([
      "--live", OWNER_FLAG, "--units", units, "--transcript", TRANSCRIPT,
      "--kill-ms", "60000", "--token-grant", "1000000", "--ask-ceiling", "1000000",
      "--out", out, "--producer", producer,
    ], { env: cleanEnv({ [LIVE_ENV]: "1" }) });
    // A completely failed run is distinguishable from a good one.
    assert.equal(result.code, 3, result.stderr);
    const stop = readLines(out).at(-1);
    assert.equal(stop.reason, "all-refused");
    assert.equal(stop.refused, stop.completed);
    assert.match(stop.detail, /no answer line carries a reading/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---- the box's default and the help text ----------------------------------

test("the default kill box is the plan's proposed value and --help names every gate", () => {
  assert.equal(DEFAULT_KILL_MS, 7_200_000);
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  for (const flag of ["--plan", "--live", "--kill-ms", "--token-grant", "--ask-ceiling",
    "--producer", "--out", OWNER_FLAG]) {
    assert.ok(help.stdout.includes(flag), `${flag} missing from --help`);
  }
  assert.match(help.stdout, new RegExp(`${LIVE_ENV}=1`));
  assert.match(help.stdout, /owner-gated/);
  // The env flag's name is exported so a test cannot drift from it.
  assert.equal(LIVE_ENV, "SIM_LIVE_ARMED");
});

test("a plan with no moments of the arm is refused by name", () => {
  const root = freshDir();
  try {
    const units = convert(path.join(root, "out"));
    const result = run(["--units", units, "--transcript", TRANSCRIPT, "--arm", "vanilla"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /sim-live-arm-absent/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("the transcript index the harness reads is the gate's own", () => {
  const rows = readTranscript(TRANSCRIPT);
  const index = indexTranscript(rows);
  assert.equal(index.landed.size >= 8, true);
  assert.equal(index.shaped.size >= 4, true);
});
