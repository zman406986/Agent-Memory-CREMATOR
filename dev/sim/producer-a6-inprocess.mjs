/**
 * A `--producer` module for `sim-live.mjs`'s lane-F pass: the real `a6` route,
 * with the key read IN-PROCESS from `~/.dsh/.credentials.yaml`.
 *
 * Usage (one line, armed once, as ISSUE-077 §"Labels and constraints" requires):
 *
 *   SIM_LIVE_ARMED=1 node dev/sim/sim-live.mjs --live --i-am-the-owner \
 *     --units <live-convert dir> --transcript <session.v4.jsonl> \
 *     --kill-ms <n> --token-grant <main> --ask-ceiling <main+asks> \
 *     --producer dev/sim/producer-a6-inprocess.mjs --out <partial.jsonl>
 *
 * WHY THIS FILE EXISTS. `sim-live.mjs`'s default producer reads
 * `process.env.A6_API_KEY`, and the standing law is that the key is read
 * in-process and never exported (plan §2 safety law 3; the run-B launcher
 * refuses a defined `A6_API_KEY`). Rather than change the harness, this module
 * uses the harness's own `--producer` seam: `ask({moment, request, signal})`
 * receives the already-built request body and returns `{text}`.
 *
 * WHAT IT DOES NOT DO. It does not build the request (that is `sim-live.mjs`'s
 * `buildAskRequest`, lane F's `forgetlines` contract), does not retry, does not
 * write evidence (the harness owns the partial JSONL), and never prints or
 * returns the key. One call per moment.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const CRED = path.join(
  process.env.USERPROFILE || process.env.HOME || "", ".dsh", ".credentials.yaml");
const BASE = process.env.SIM_LIVE_BASE_URL ?? "https://api.a6api.com/v1";

function keyInProcess() {
  const text = readFileSync(CRED, "utf8");
  const match = text.match(/^\s*A6_API_KEY:\s*(\S+)\s*$/m);
  if (match === null) {
    throw new Error(`producer-a6-inprocess: no A6_API_KEY in ${CRED}`);
  }
  return match[1];
}

/** The harness's producer contract: `ask({moment, request, signal})` -> `{text}`. */
export async function ask({ request, signal }) {
  const response = await fetch(`${BASE.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${keyInProcess()}` },
    body: JSON.stringify(request.body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`producer-a6-inprocess: the route answered ${response.status}`);
  }
  const raw = await response.text();
  let answer = "";
  let usage = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const chunk = JSON.parse(payload);
      const piece = chunk?.choices?.[0]?.delta?.content;
      if (typeof piece === "string") answer += piece;
      // The route's last frame is the bill (`stream_options.include_usage`).
      // A missing frame is `null`, never `0`: the pass prints absent, not free.
      if (chunk?.usage !== undefined && chunk.usage !== null) usage = chunk.usage;
    } catch { /* a non-JSON keepalive frame is the route's own */ }
  }
  if (answer === "") throw new Error("producer-a6-inprocess: the route returned no text");
  return { text: answer, usage };
}

export default ask;
