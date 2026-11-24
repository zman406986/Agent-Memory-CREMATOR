#!/usr/bin/env node
/**
 * Bench arm launcher — one arm, one dsh process, one wall-clock box.
 *
 * This is the bench's own launcher; `dev/dsh-rig/run.mjs` is untouched and
 * keeps its scenario contract. The mechanics are reused (throwaway DSH_HOME,
 * loopback mock, `taskkill /T /F` watchdog, evidence collection); the
 * differences are the ones the bench needs:
 *
 *   - The working directory is the ARM itself (`<root>/racoons-arm` or
 *     `<root>/vanilla-arm`), never a copy under the evidence dir. The arm is
 *     the still image; the run is what edits it. `--dry-work` copies the arm to
 *     `<evidence>/work/` instead, which is the only mode the mock smoke uses.
 *   - The first user message is the fenced task under `## Task text` in
 *     `--brief` (default `dev/bench/bench-brief.md`), byte-for-byte. It reaches
 *     dsh on stdin (`-`), so there is no argv length cap.
 *   - `patch.yml` is one file: the base/tier-3 rows, then the racoons mount row
 *     (racoons arm only), then the no-official-endpoint rows, then the eight
 *     deny rows from `subagent-deny.md` LAST. Later rows win, so neither the
 *     official-endpoint removal nor the deny can be re-opened by an earlier row.
 *   - The racoons arm mounts the SHIPPED entry
 *     (`packages/adapters/dsh/src/plugin.js` inside `--plugin-dist`, default
 *     `scratchpad/dsh-rig/dist` built by `dev/dsh-rig/build-dist.mjs`), with
 *     the cap pair named explicitly: capBytes 8192, capHeadBytes 8192,
 *     sealMaxLatencyTurns 1. The vanilla arm gets no mount; its native
 *     compaction stands. On a journal-gated route — mock-replay AND the live
 *     route — the racoons arm mounts the rig's committed wrapper instead
 *     (`dev/dsh-rig/rig-plugin.mjs`), which loads the same shipped entry and
 *     supplies the two seams the bench needs evidence from: the journal sink
 *     (`<evidence>/racoons/cremator-events.jsonl`) and the storage root the entry
 *     opens its own per-session ledger under
 *     (`<evidence>/racoons/storage/sessions/<id>/ledger.sqlite`). Before
 *     ISSUE-082 only the replay was gated, so every real-API run mounted the
 *     shipped entry — whose default export cannot take a sink — and discarded
 *     its whole journal. `--plugin-entry` still overrides the entry on every
 *     provider; pointing it at the shipped entry is the presence perturbation
 *     (no sink, so the journal assertion fails by name) and it does NOT disarm
 *     the gate.
 *   - Evidence lands under `scratchpad/bench/2026-10-23-taskworld/`: `<arm>/`
 *     for a real run, `<arm>-mock/` in mock mode, so a harness proof can never
 *     be mistaken for the real run. Session logs, the mock request log,
 *     stdout.ndjson, and `result.json` with exit code, timing, token usage,
 *     the deny-probe record, and every assertion. A journal-gated racoons run
 *     adds `<arm>/racoons/` (real) or `<arm>-mock-replay/racoons/`, where the
 *     mount's journal lives and where the entry's own per-session storage
 *     (including its ledger) was written (see `journal` in `result.json`, under
 *     `mockReplay` on the replay lane).
 *
 * Providers:
 *   mock     `mock-messages.mjs` on `--port 0`; `DEEPSEEK_BASE_URL` points at
 *            it and a dummy key is the only key in the child env. The mock
 *            script file is required (`--mock-script`, default
 *            `dev/bench/mock-smoke.script.json`). A mock run requires
 *            `--dry-work`: a scripted model must never dirty a real arm.
 *   mock-replay  The mock above, but the script is not a checked-in fixture: it
 *            is converted from a recorded zcode `transcript.jsonl` (`--record`)
 *            by `dev/dsh-rig/replay.mjs`, then path-rewritten by the committed
 *            map (`--record-map`) so every recorded `read`/`edit` names a file
 *            the arm actually holds. Both flags are required and the map binds
 *            the record sha256, the caps and the text mode; a mismatch is exit
 *            2 before any process starts. The deny probe is SKIPPED here: a
 *            record carries no scripted `subagent` call, so leg B has nothing
 *            to measure, and the probe stays on `mock-smoke` (ISSUE-023 §4).
 *            Leg A still reads the header. A `replay-end` terminator reply ends
 *            the conversation where the record does; usage is fabricated by the
 *            mock, so `result.json` marks it estimated.
 *   deepseek-official, deepseek-v4-pro
 *            No mock and no key in the environment. The child keeps the real
 *            `DSH_HOME`, the tier-3 overlay re-enables `credentials` and
 *            points it at `RIG_CREDENTIALS_PATH` (a path, never the key), and
 *            the session/storage roots are redirected into the evidence dir.
 *            Refuses to start unless `BENCH_REAL_API=1`, so a real call is
 *            always an explicit act.
 *
 * `--preflight` stops after `--dump-config`: it spends nothing, touches no
 * arm, and prints whether the eight deny rows composed to `disabled: true` and
 * whether the mount row resolved. `--omit-deny-rows` is the perturbation that
 * proves the probe can fail; it is never a bench configuration.
 *
 * Fidelity (mock-replay only): parity across arms is harness parity, so the
 * projection is not enough. Each main request's matcher keys must EQUAL the
 * keys the served `<evidence>/script.json` states for that turn — the script is
 * the spec, read back from disk, never the in-memory copy the mock holds. The
 * tool-failure multiset must be exactly the scripted `edit` constant (a
 * replayed edit carries foreign prose, so `FS_EDIT_NOT_FOUND` is expected and
 * every other failure is not).
 *
 * Journal gates (mock-replay and the live route): the racoons arm mounts the rig
 * wrapper, so its journal is an expected artifact on BOTH routes:
 * `<evidence>/racoons/cremator-events.jsonl` must exist, every line must parse,
 * and it must carry the mount's own `mounted` line naming the storage root this
 * run configured — a line no stub can produce, which is what makes the gate
 * non-vacuous. The entry's own per-session ledger must exist under
 * `<evidence>/racoons/storage/sessions/<id>/ledger.sqlite` (the pre-bb33dc7
 * host-injected `<evidence>/racoons/ledger.sqlite` is read only as a deprecated
 * fallback).
 * Cap/seal/recall counts are recorded as evidence (what this mount did to this
 * record), never asserted against a target. Two gates stand on that evidence
 * (ISSUE-089): `fidelity: no cap archives exist (ADR-0014)` is an invariant —
 * ADR-0014 scrapped cap materialization, so any `cap` archive is red — and
 * `fidelity: the <arm> arm's tool/result replacements match the applied
 * removals` compares the session log's `tool/result` replaces against the
 * journal's applied-removal lanes (`journal-fidelity.mjs` has the list and the
 * citation for each). The vanilla arm must emit neither file. Pointing
 * `--plugin-entry` at the shipped entry is the presence perturbation: the mount
 * then has no sink and the assertion fails by name.
 *
 * `--perturb-swap-match i,j` swaps two replies' matchers (1-based, in the
 * served script) after conversion. It exists to prove the request-key gate
 * fails by name — swap two single-call turns and the counts drift one slot —
 * and it is never a bench configuration.
 *
 * Determinism gate (mock-replay only): `--projection-out <file>` records the
 * canonical projection of a finished run — arm, provider, script sha256, the
 * per-request matcher tuples, the matched reply names, the tool-call sequence
 * and the tool-failure constant. `--projection-in <file>` compares a fresh run
 * against a stored projection and fails BY NAME, with expected and actual for
 * every differing key. Timestamps, absolute evidence paths, usage rows, the
 * title request and the terminator's ordinal are deliberately absent: they move
 * between two runs of the same arm. The baseline belongs outside the evidence
 * dir, which is wiped at start.
 *
 * The wall-clock kill timer is OFF by default (`--kill-ms 0`): the token grant
 * is the only cap. A positive `--kill-ms` arms it before any wait, with
 * `taskkill /PID <pid> /T /F`; a run the box had to kill is a timeout, never a
 * bench result.
 *
 * `--token-grant <n>` is the second, independent stopper: an in-run ceiling in
 * TRUE tokens — main prompt + main output + ask input + ask output + the native
 * compaction call's prompt and output — the sum the
 * watchdog compares, read from the session log and the mount journal. While the
 * child runs, its session log (`session.v4.jsonl` or a host-named
 * `session-<id>.v4.jsonl`) is polled every 12 s and at or past the
 * grant the tree is killed through the same `taskkill` path and the run exits 1
 * — a budget reached is a timeout of the spend, exactly like the box is a
 * timeout of the clock. The flag sets the ceiling for this run only: no default
 * cap is implied, and a paid provider without it is refused. Either stopper may
 * fire; each records its own fields under `watchdog` in `result.json` (`fired`
 * for the box, `tokenFired`/`trueTotalTokens`/`observedPromptTokens`/`firedAt`
 * for the grant). Omitted: no ceiling, nothing is polled, and
 * `watchdog.tokenGrant` is `null` so a reader cannot mistake "no ceiling was
 * set" for "the ceiling held".
 *
 * `--stop-at-checkpoint <relative path>` is the work-checkpoint stopper for the
 * 2026-11-08 rerun: the launcher polls the arm dir and, at the first poll that
 * finds the file, kills the tree through the same `taskkill` path. The path is
 * relative to the arm (the agent's working directory), must not be absolute and
 * must not contain `..`, and must be ABSENT at launch — a stop at t=0 measures
 * nothing. The run is a CENSORED PARTIAL, not a pass: exit 1, name
 * `stopped-at-checkpoint`, `result.json.stop` says `censored: true`, and the
 * pair is compared only at the largest checkpoint both arms reach. The stop is
 * recorded with the path, the billed total and the compaction count at the
 * fire; a child that had already ended records `killLanded: false` rather than
 * claiming a kill it did not need.
 *
 * `--stop-after-compactions <n>` is the same landmark rule at the Nth native
 * compaction instead of the first. It is an independent stop beside the
 * checkpoint: whichever fires first ends the run, and the record names which
 * (name `stopped-after-compactions`). `n` is a positive integer; the post-run
 * reader states the observed count and the nth position, never an invented one.
 *
 * `--stop-on-compaction` is the third stopper and the only one that is a
 * LANDMARK rather than a budget: at the session's first native compaction
 * (`compaction/start`, written by `compaction-basic` before its summarization
 * ask) the tree is killed through the same `taskkill` path and the run ends.
 * The reason to have it: a compaction is the event a prune measurement is read
 * up to, so a run that pays for the steps after it pays for a decision already
 * made. The run must not read as either a green or a crash, so it takes exit 1
 * with its own name (`stopped-on-compaction`), `result.json` carries
 * `stoppedOnCompaction: true` and the crossing's `step`/`seq`/billed total under
 * `watchdog`, and `passed` stays `false` because the task never completed. The
 * child's own `exit code` and the compaction's start/end pairing are not
 * assertable on such a run and are stated as such, never reported red. Omitted:
 * nothing is counted and every existing run's record is unchanged.
 *
 * Usage:
 *   node dev/bench/bench-run.mjs --arm vanilla --provider mock --dry-work
 *   node dev/bench/bench-run.mjs --arm racoons --provider mock-replay --dry-work \
 *     --record <transcript.jsonl> --record-map dev/bench/replay-map/<map>.json
 *   node dev/bench/bench-run.mjs --arm racoons --provider mock-replay --dry-work \
 *     --record <transcript.jsonl> --record-map dev/bench/replay-map/<map>.json \
 *     --projection-out scratchpad/bench/<campaign>/racoons.projection.json
 *   node dev/bench/bench-run.mjs --arm racoons --provider mock-replay --dry-work \
 *     --record <transcript.jsonl> --record-map dev/bench/replay-map/<map>.json \
 *     --projection-in scratchpad/bench/<campaign>/racoons.projection.json
 *   node dev/bench/bench-run.mjs --arm racoons --provider mock-replay --dry-work \
 *     --record <transcript.jsonl> --record-map dev/bench/replay-map/<map>.json \
 *     --perturb-swap-match 3,4   # perturbation: this run MUST fail by name
 *   node dev/bench/bench-run.mjs --arm racoons --provider deepseek-official \
 *     --allow-official-spend --preflight
 *   BENCH_REAL_API=1 node dev/bench/bench-run.mjs --arm racoons \
 *     --provider deepseek-official --allow-official-spend \
 *     --manifest dev/bench/manifests/<round>.manifest.json \
 *     --token-grant 100000000     # the only run cap; no wall-clock timer
 *   BENCH_REAL_API=1 node dev/bench/bench-run.mjs --arm racoons \
 *     --provider deepseek-official --allow-official-spend \
 *     --manifest dev/bench/manifests/<round>.manifest.json \
 *     --stop-on-compaction       # stop at the host's first native compaction
 *   BENCH_REAL_API=1 node dev/bench/bench-run.mjs --arm racoons \
 *     --provider deepseek-official --allow-official-spend \
 *     --resume scratchpad/bench/<campaign>/<arm> --task-file <follow-up.md> \
 *     --token-grant 100000000     # continue the persisted session, new task
 *
 * Resume mode (`--resume <evidence dir>` + `--task-file <file>`): the evidence
 * dir is NOT wiped. The previous `result.json`/`stdout.ndjson` move into
 * `<evidence>/round-N/`, the session id is read from the ONE
 * `session-*.v4.jsonl` under `<evidence>/sessions` and passed as
 * `--session-id`, and the new round's BENCH-DONE must carry a seq above the
 * pre-launch boundary. The manifest brief-hash and arm-tree gates are skipped
 * (the task is new and the arm holds prior deliverables); the arm digest and
 * the pre-launch deliverable rows are recorded under `work.startDigest` and
 * `work.priorDeliverables`, and the round must write every deliverable that
 * was missing before it (a round that writes nothing is red). The expected
 * list is the follow-up's own final explicit list of names or paths (parsed
 * from the `--task-file` text, resolved against the directory it names), so a
 * 19-name follow-up expects 19, not the default 13; `--deliverables` still
 * wins. A follow-up with no explicit list keeps the thirteen defaults but the
 * gate row is `not-applicable` rather than a red 0-owed row. `result.json`
 * records `round`, `resumedFrom` and `rounds`.
 *
 * Exit codes: 0 all assertions pass, the deny probe is `pass` or the known
 * real-route `partial` shape, and no out-of-scope read was recorded;
 * 1 an assertion failed or the box fired; 2 bad arguments or a refused
 * preflight; 3 the deny probe is `partial` — header-only proof, the round-2
 * arm's known shape when the model was never offered a reason to summon, and
 * the arm's own assertions are all green (ISSUE-038: 3 is a separate,
 * REACHABLE outcome, checked only after the arm itself is clean);
 * 4 an out-of-scope read: the arm named a path inside the campaign tree but
 * outside its own world (ISSUE-039), so the A/B pairing is contaminated.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalScript, convertTranscript } from '../dsh-rig/replay.mjs';
import { ensureDist } from '../dsh-rig/build-dist.mjs';
import { countPruneFires } from '../dsh-rig/prune-fires.mjs';
import { loadReplayMap, rewriteScript } from './mock-replay.mjs';
import { applyScriptedEdit } from './edit-replay.mjs';
import { CHILD_ENV_ALLOW, DSH_ONLY } from './child-env-allow.mjs';
import {
  campaignRootFor, classifyToolCalls, describeViolation, inside as pathInside, worldLayoutViolations,
} from './read-boundary.mjs';
import { EXIT_CODES, exitCodeFor, legBOutcome } from './launch-outcome.mjs';
import { chooseMountEntry, mountedLineGate } from './mount-wiring.mjs';
import { CAP_ARCHIVE_GATE, capArchiveGate, hostPrunerTrims, journalLanes, replacementAccounting,
  replacementGateName, removalCitable, removalLedgerGate, removalSummary,
  REMOVAL_LEDGER_GATE } from './journal-fidelity.mjs';
import { distTreeSha256 } from './dist-hash.mjs';
import { LOOPBACK_GATE, loopbackGate } from './loopback-gate.mjs';
import { armTreeGate, manifestEnforcementRecord, manifestTaskGate, paidRouteManifestGate, taskSha256 } from './manifest-gate.mjs';
import { findSessionLogs, SessionUsageWatch, TOKEN_POLL_MS, UsageTail, createTokenWatchdog, watchdogRecord } from './token-watchdog.mjs';
import { usageGap, usageRows as sessionUsageRows } from './session-usage.mjs';
import { AskSource, askJournalOffsets } from './token-alarm.mjs';
import { DEFAULT_DELIVERABLES, deliverablesFromBrief, parseDeliverables } from './dsh-checkpoints.mjs';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';
import { timerDelayRefusal } from '../shared/timer-ms.mjs';
import { samePath } from '../shared/paths.mjs';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
/** The repository root; a launch's evidence must live under its scratchpad. */
export const REPO_ROOT = dirname(dirname(BENCH_DIR));
/** The one evidence tree a launch may write: this repo's gitignored scratchpad. */
export const SCRATCHPAD = join(REPO_ROOT, 'scratchpad');
const MOCK = join(REPO_ROOT, 'dev', 'dsh-rig', 'mock-messages.mjs');
const CAMPAIGN = '2026-10-23-taskworld';
/** The launcher's defaults. `killMs: 0` is OFF: the token grant is the only
 * run cap, and a wall-clock timer is armed only when `--kill-ms` asks for one. */
export const DEFAULTS = Object.freeze({
  root: `C:/Users/TZhen/Desktop/racoons-bench/${CAMPAIGN}`,
  brief: join(BENCH_DIR, 'bench-brief.md'),
  mockScript: join(BENCH_DIR, 'mock-smoke.script.json'),
  pluginDist: join(REPO_ROOT, 'scratchpad', 'dsh-rig', 'dist'),
  killMs: 0,
  windowTokens: 400_000,
  hostWindowTokens: 400_000,
});

/**
 * Read `--kill-ms`: `0` (the default) is OFF, a positive safe integer is an
 * optional wall-clock cap, and a negative value or a fraction is a typo, not a
 * cap. A delay above the platform maximum is refused as well: `setTimeout`
 * would fire it at 1 ms and kill the run before its first turn (ISSUE-580).
 * The token grant is the only cap a default run carries.
 */
export function killMsValue(raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    return { ok: false, message: 'bench-run.mjs: --kill-ms takes a non-negative'
      + ' integer; 0 (the default) arms no timer, a positive value arms one' };
  }
  const tooLong = timerDelayRefusal(value, '--kill-ms');
  if (tooLong !== null) return { ok: false, message: `bench-run.mjs: ${tooLong}` };
  return { ok: true, value };
}

/**
 * The names a child may inherit: the shared base plus the three home
 * variables this lane's redirect does not override (43 names). Everything
 * else — every provider key, cloud secret, token, credential store path,
 * `RIG_*`/`BENCH_*` control variable — is dropped before the FIRST child
 * starts (`--version`), so no later child can leak what the version probe
 * already carried. The list is deliberately the platform's process plumbing
 * plus locale/time and identity, never a credential.
 */
const CHILD_ENV_ALLOW_NAMES = new Set(
  [...CHILD_ENV_ALLOW, ...DSH_ONLY].map((name) => name.toLowerCase()),
);

/**
 * The child environment: an explicit allow-list, never `{ ...process.env }`
 * followed by a denylist. `env` and the allow-list are injectable so a test can
 * prove a synthetic credential cannot survive.
 * @param {Record<string, string|undefined>} [env]
 * @param {Set<string>} [allow]
 * @returns {Record<string, string>}
 */
export function childEnvBase(env = process.env, allow = CHILD_ENV_ALLOW_NAMES) {
  const out = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (value === undefined) continue;
    if (!allow.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/** The key shapes a task must never carry. They are values, not the names. */
const TASK_KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /\bAIza[0-9A-Za-z_-]{30,}\b/u,
];
const TASK_KEY_ASSIGNMENT = /\b(?:DEEPSEEK|OPENAI|ANTHROPIC|GEMINI|GOOGLE|AWS|AZURE|GITHUB|GITLAB|HF|HUGGINGFACE|OPENROUTER|MOONSHOT|QWEN|DASHSCOPE|SILICONFLOW)(?:_[A-Z0-9]+)*_(?:API_KEY|KEY|SECRET|TOKEN|ACCESS_KEY)\b\s*[=:]\s*["']?[A-Za-z0-9_./+~-]{8,}/u;

/**
 * Why a task text may not be sent to a provider, or null. A key in the task is
 * a key in the prompt, the session log and the evidence dir; the scan is the
 * early refusal, not a redaction. A bare environment NAME (the brief's own
 * "never exported" instruction) is not a value and passes.
 * @param {string} text
 * @returns {string|null}
 */
export function taskKeyRefusal(text) {
  const source = String(text ?? '');
  if (TASK_KEY_ASSIGNMENT.test(source)) {
    return 'the task text carries a provider key assignment (NAME=value); '
      + 'a key in the task reaches the prompt, the session log and the evidence';
  }
  if (TASK_KEY_PATTERNS.some((pattern) => pattern.test(source))) {
    return 'the task text carries a provider key shape (sk-…, ghp_…, AKIA…, …); '
      + 'a key in the task reaches the prompt, the session log and the evidence';
  }
  return null;
}

/**
 * Read `--stop-at-checkpoint`: a file path relative to the arm (the agent's
 * working directory). It must name a file, not a directory; it must be
 * relative; and no `..` segment is accepted, so the stop file cannot live
 * outside the arm. The normal form uses `/` separators in the record; the
 * launcher resolves it against the arm's working directory.
 * @param {string} raw
 * @returns {{ok: true, value: string}|{ok: false, message: string}}
 */
export function checkpointPathValue(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') {
    return { ok: false, message: 'bench-run.mjs: --stop-at-checkpoint takes a file path relative to the arm '
      + '(e.g. docs/plans/2026-10-27-extended-audit/07-plan-traceability.md)' };
  }
  const normalized = text.split(/[\\/]/u).filter((part) => part !== '' && part !== '.').join('/');
  if (normalized === '' || isAbsolute(text) || /^[A-Za-z]:/u.test(text)) {
    return { ok: false, message: `bench-run.mjs: --stop-at-checkpoint ${JSON.stringify(raw)} must be relative `
      + 'to the arm (an absolute path would let the stop watch any file on the machine)' };
  }
  if (normalized.split('/').includes('..')) {
    return { ok: false, message: `bench-run.mjs: --stop-at-checkpoint ${JSON.stringify(raw)} must not contain ` +
      "'..' (the stop file lives inside the arm)" };
  }
  if (/[\\/]$/u.test(text)) {
    return { ok: false, message: `bench-run.mjs: --stop-at-checkpoint ${JSON.stringify(raw)} names a directory; `
      + 'give a file path' };
  }
  return { ok: true, value: normalized };
}

/**
 * Read `--stop-after-compactions`: the Nth native compaction as a positive
 * integer. Zero would stop before any compaction exists and a fraction names
 * no compaction; both are typos, not stops.
 * @param {string} raw
 * @returns {{ok: true, value: number}|{ok: false, message: string}}
 */
export function stopAfterCompactionsValue(raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    return { ok: false, message: 'bench-run.mjs: --stop-after-compactions takes a positive integer '
      + 'compaction count (e.g. 2)' };
  }
  return { ok: true, value };
}

/**
 * The work-checkpoint / compaction-limit stopper (2026-11-08 rerun).
 *
 * It is a small controller beside `createTokenWatchdog`, not a second token
 * meter: it polls the SAME `SessionUsageWatch` the grant reads, so the stop's
 * billed total and compaction count are the grant's own quantity. Two
 * independent conditions, one fire:
 *
 *   - `checkpointFile`: the first poll whose `exists()` is true stops the run;
 *   - `stopAfterCompactions`: the first poll whose `watch.compactions` is at or
 *     past the limit stops it.
 *
 * `--stop-at-checkpoint` is checked first when both would fire in one poll: the
 * work checkpoint is the owner's chosen stop and the compaction limit is a
 * safety net, so the record names the checkpoint. Both are one-way (`fired`
 * guards every branch), and `stop()` halts the poller so a later final poll
 * cannot invent a second stop.
 *
 * The callback's return value is the KILL outcome: the launcher passes
 * `() => reap()`, so `killLanded` is true only when a live child was actually
 * killed. A child that had already ended records false rather than claiming a
 * kill it did not need. This module never writes `result.json`; the launcher
 * does, after the child exits, which is why a checkpoint stop is analysable
 * (the SIGINT path exits 130 without a result and is not used for a stop).
 *
 * A checkpoint stop is CONTIGUOUS: `checkpointPrerequisites` names the earlier
 * checkpoint files that must also exist. If the target appears while a
 * predecessor is missing, the watchdog keeps polling; it fires only when the
 * whole prefix exists. A target that is not in the expected list has no
 * prerequisites and keeps the old file-only rule.
 *
 * Inert when neither condition is armed: `start()` reads nothing and `state`
 * carries the two nulls it was given.
 *
 * @param {object} input
 * @param {string|null} [input.checkpointPath] - the workspace-relative label.
 * @param {string|null} [input.checkpointFile] - the absolute file to watch.
 * @param {string[]|null} [input.checkpointPrerequisites] - absolute files that
 *   must exist before the stop fires (the contiguous prefix, excluding target).
 * @param {number|null} [input.stopAfterCompactions] - the Nth compaction.
 * @param {{poll: () => {billedPromptTokens: number}, compactions?: number}} input.watch
 * @param {number} [input.pollMs] - interval; tests pass a short one.
 * @param {(event: object) => boolean} [input.onCheckpoint] - the kill; return
 *   true when a live child was killed.
 * @param {(event: object) => boolean} [input.onCompactionLimit] - the kill.
 * @param {() => number} [input.now] - clock for `firedAt`.
 * @param {(file: string) => boolean} [input.exists] - injectable for tests.
 * @returns {{state: object, start: () => void, stop: () => void,
 *   pollOnce: () => object, finalPoll: () => object}}
 */
export function createPolicyWatchdog({
  checkpointPath = null, checkpointFile = null, checkpointPrerequisites = null,
  stopAfterCompactions = null, watch,
  pollMs = TOKEN_POLL_MS, onCheckpoint = () => false, onCompactionLimit = () => false,
  now = () => Date.now(), exists = existsSync,
}) {
  const prerequisites = Array.isArray(checkpointPrerequisites) ? [...checkpointPrerequisites] : [];
  const armed = checkpointFile !== null || stopAfterCompactions !== null;
  const state = {
    checkpoint: checkpointPath,
    checkpointPrerequisites: prerequisites,
    checkpointMissingPrerequisites: [],
    stopAfterCompactions,
    checkpointFired: false,
    checkpointStoppedAt: null,
    compactionLimitFired: false,
    compactionLimitStoppedAt: null,
    compactions: 0,
    polls: 0,
    error: null,
  };
  let timer = null;
  let fired = false;
  let halted = false;

  const pollOnce = () => {
    if (!armed || halted) return state;
    let totals;
    try {
      totals = watch.poll();
    } catch (error) {
      state.error = error?.message ?? String(error);
      return state;
    }
    state.polls += 1;
    state.compactions = Number.isFinite(watch.compactions) ? watch.compactions : 0;
    const billed = totals !== null && typeof totals?.billedPromptTokens === 'number'
      ? totals.billedPromptTokens : null;
    if (fired) return state;
    if (checkpointFile !== null && exists(checkpointFile)) {
      const missing = prerequisites.filter((file) => !exists(file));
      state.checkpointMissingPrerequisites = missing;
      if (missing.length === 0) {
        fired = true;
        const at = {
          path: checkpointPath,
          resolved: checkpointFile,
          firedAt: new Date(now()).toISOString(),
          billedPromptTokens: billed,
          compactions: state.compactions,
        };
        state.checkpointFired = true;
        state.checkpointStoppedAt = { ...at, killLanded: onCheckpoint(at) === true };
        stop();
        return state;
      }
      // The target exists but its contiguous prefix does not: keep running.
    } else {
      state.checkpointMissingPrerequisites = [];
    }
    if (stopAfterCompactions !== null && state.compactions >= stopAfterCompactions) {
      fired = true;
      const at = {
        limit: stopAfterCompactions,
        observed: state.compactions,
        firedAt: new Date(now()).toISOString(),
        billedPromptTokens: billed,
      };
      state.compactionLimitFired = true;
      state.compactionLimitStoppedAt = { ...at, killLanded: onCompactionLimit(at) === true };
      stop();
    }
    return state;
  };

  const start = () => {
    if (!armed || timer !== null || halted) return;
    pollOnce();
    if (halted) return;
    timer = setInterval(pollOnce, pollMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  /** Halt the poller. A halt is final: the launcher's final poll cannot fire. */
  const stop = () => {
    halted = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { state, start, stop, pollOnce, finalPoll: pollOnce };
}

/**
 * Arm the wall-clock box only when a positive cap was asked for. Returns the
 * timer handle, or null when no box is armed (`--kill-ms 0`), so a caller can
 * state `timer: "off"` without guessing from a sentinel.
 */
export function armKillBox({ killMs, onFire, schedule = setTimeout }) {
  const parsed = killMsValue(killMs);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value === 0 ? null : schedule(onFire, parsed.value);
}
/**
 * The mount window the real route runs with when `--window-tokens` is omitted
 * (owner clarification 2026-10-24, ISSUE-035). The owner's 200 000 is the
 * big-prune firing bar, not the window: the mount's bar is half its window, so
 * the window is the host's native 400 000, giving a prune bar of 200 000 and a
 * native-compaction backstop at the host's own 400 000. A 60 000 mount window
 * put the bar at 30 000 and forced a native compaction at 103 112 billed
 * tokens, far below the host's threshold, so the run measured the backstop
 * instead of the prune.
 */
const REAL_ROUTE_WINDOW_TOKENS = DEFAULTS.windowTokens;
/**
 * The dsh host's native compaction window on a real route when
 * `--host-window-tokens` is omitted (ISSUE-291). The flag exists to run the
 * host at a smaller window: dsh's `compaction-basic` triggers at
 * `min(0.8 × window, window − 65,536)`, so 400 000 compacts at 320 000 and
 * 200 000 at 134 464. Mock lanes keep the shipped value; their thresholds
 * belong to the fixtures.
 */
const HOST_WINDOW_TOKENS = DEFAULTS.hostWindowTokens;
/** Providers. `mock` and `mock-replay` share the loopback mock; they differ in
 * where the script comes from and in which assertions apply. */
const PROVIDERS = new Set(['mock', 'mock-replay', 'deepseek-official', 'deepseek-v4-pro']);
/** Providers whose child env carries the loopback base URL and dummy key. */
const MOCK_PROVIDERS = new Set(['mock', 'mock-replay']);
/** Providers that reach a real endpoint through the credential store. */
const REAL_PROVIDERS = new Set(['deepseek-official', 'deepseek-v4-pro']);
/** The one reply appended after the record's last scripted turn. A record is a
 * prefix that simply stops; without a terminator the next request is a mock
 * `no-match` (a loud 500) and the arm ends on a provider error instead of a
 * finished answer. Text uses the converter's own placeholder form, so the
 * appended turn still carries no recorded prose. */
const REPLAY_TERMINATOR_TEXT = '<replay record end: no further turn recorded>';
/** The map's fallback caps when it does not state them (converter defaults). */
const REPLAY_TEXT_CAP = 4000;
const REPLAY_MAX_REPLIES = 24;
/**
 * The line that ends every table ask's user message (`PRUNE_ASK_FINAL_LINE` in
 * `packages/core/src/prune/ask-message.ts`). Copied, not imported, exactly as
 * `dev/dsh-rig/mock-messages.mjs` copies it: the bench treats the wire shape as
 * a fact of the host, not as something to keep in sync through a TypeScript
 * import.
 *
 * Since ADR-0028 the bulk prune is the ONE table asker: the ask carries main's
 * tools and ends with this line. There is no second caller and no row-count
 * discriminator; a 1-row table is the prune lane exactly as a 12-row one is.
 */
const PRUNE_ASK_FINAL_LINE = 'Answer with one JSON object that maps every index above to its verdict, one entry per index: {"1":{"keepall":true},"2":{"forgetall":"…"}}';
/**
 * The matcher the table (prune) lane keys on, derived from the copied final
 * line so the two can never drift. It deliberately states NO `tools_length`:
 * the fork ask carries main's tools once main has been captured, and a first
 * ask seeded before that carries none; both end with this line and both are
 * the prune lane.
 */
const PRUNE_MATCH_PATTERN = `${PRUNE_ASK_FINAL_LINE.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*$`;
/**
 * Prune reply rows a mock-replay racoons script is prefixed with. A QUEUE with
 * no ordinal in the matcher: one row answers every prune table, and rows past
 * the last ask are never reached. 16 covers more than one pass's tables (12
 * units per table) without a cost.
 */
const PRUNE_REPLY_CEILING = 16;
/** What every prune row answers: forgetall for every index the ask carries. */
const PRUNE_REPLY_TEXT = '{{forgetallTableAnswer}}';
/** Why mock-replay records `denyProbe: "skipped"` instead of a verdict. */
const DENY_SKIP_REASON = 'replay record has no scripted subagent call';
/** Dummy key; the child env carries nothing else that looks like a key. */
const DUMMY_KEY = 'mock-key-not-real';
const DSH_PACKAGE = ['@deepseek-ai', 'dsh', 'lib', 'bin.js'];
/**
 * The real routes, one record per `--provider`, identical in wiring and
 * different only in the model id, on the official OpenAI-compatible endpoint.
 * The official DeepSeek route is the only live route (owner ruling 2026-11-09).
 * The key is never exported: `apiKeyEnv` is a NAME the credentials row resolves
 * from `RIG_CREDENTIALS_PATH`, exactly as before.
 */
const REAL_ROUTES = {
  'deepseek-official': {
    provider: 'deepseek', model: 'deepseek-flash',
    baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  'deepseek-v4-pro': {
    provider: 'deepseek', model: 'deepseek-v4-pro',
    baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
};
/** The shipped entry inside a dist tree. */
const PLUGIN_ENTRY = ['packages', 'adapters', 'dsh', 'src', 'plugin.js'];
/**
 * The rig's committed wrapper, which loads the same shipped entry and adds the
 * two seams a bench evidence dir needs: a journal sink and an on-disk ledger.
 * `dev/dsh-rig/rig-plugin.mjs`, not the dist tree: it is committed and it names
 * `CREMATOR_RIG_DIST` for the compiled workspace.
 */
const RIG_WRAPPER = join(REPO_ROOT, 'dev', 'dsh-rig', 'rig-plugin.mjs');
/** Where the wrapper writes: `<evidence>/racoons/`, the rig's own convention. */
const CREMATOR_EVIDENCE_DIR = 'racoons';
/**
 * The wrapper's storage root under the evidence dir (`rig-plugin.mjs` default).
 * Since bb33dc7 the wrapper injects no ledger: it points the entry's own
 * `crematorStorageRoot` here, and the entry opens one SQLite file per session
 * under `<storageRoot>/sessions/<sessionId>/ledger.sqlite` (ADR-0013).
 */
const CREMATOR_STORAGE_DIR = 'storage';
/**
 * The pre-bb33dc7 host-injected ledger, `<evidence>/racoons/ledger.sqlite`.
 * Kept as a deprecated fallback so an evidence dir produced before that commit
 * still reads; every failure names it beside the per-session path.
 */
const LEGACY_LEDGER_FILE = 'ledger.sqlite';
/**
 * Historical keys the mount row still carries. `capBytes` and `capHeadBytes`
 * are ACCEPTED AND IGNORED — ADR-0014 decision 1 scrapped cap materialization
 * and ADR-0048 restates it product-wide — so writing them here is compatibility
 * for an old config, never a mechanism this bench turns on. `sealMaxLatencyTurns`
 * is the one live bound in this object (ADR-0014 decision 6's bar survives).
 */
export const INERT_CAP_KEYS = Object.freeze({ capBytes: 8192, capHeadBytes: 8192 });
/** The live bound the mount reads. It is not part of the inert cap pair. */
export const LIVE_SEAL_BOUND = 1;
const CAP_CONFIG = Object.freeze({ ...INERT_CAP_KEYS, sealMaxLatencyTurns: LIVE_SEAL_BOUND });
/**
 * How much of the assistant-turn population must still carry reasoning for a
 * measurement run to be evidence. ADR-0045: a session without the agent's
 * reasoning is a smaller conversation than the one the agent had, so zero
 * reasoning refuses and a partial loss below this DECLARED floor refuses too.
 * The value matches the dsh sim's `REASONING_TURN_COVERAGE_FLOOR`: the pinned
 * 2026-10-29 record reads 86 / 139 = 0.6187 (some assistant turns legitimately
 * carry no reasoning), so 0.55 sits under it and above one-half. The audit
 * (ISSUE-214 item 1) wanted the floor declared and recorded, not inferred.
 */
export const REASONING_TURN_COVERAGE_FLOOR = 0.55;
/**
 * Synthetic pressure (`--inflate-bytes`): every scripted shell call is told to
 * print this many ASCII lines AFTER its own output, so each tool RESULT the
 * replayed record produces carries at least `minBytes` bytes. The filler is a
 * function of the row index only, so two runs with the same N serve byte-equal
 * scripts. It exists because a record's own results are too small to reach the
 * host's compaction trigger; it measures the cap/compaction MECHANISM, never
 * the record's economics (see `reference.md` § "Synthetic pressure").
 *
 * `body_bytes` per request is the measure used for the context series, so the
 * host's own post-execute caps (spill-policy 12,500 tokens; the read tool's
 * 50 KiB) still bound what the model sees. The flag states the request to the
 * command, not a promise about the delivered size: a result the host clips is
 * reported as clipped.
 */
const FILLER_PREFIX = '[synthetic pressure row ';
/** `[synthetic pressure row 1]` plus its newline: the shortest filler line. */
const FILLER_MIN_LINE = 25;
/** Tools whose scripted call can be asked to emit filler after its own output. */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'sh']);
/**
 * The host's compaction-basic summarization ask. Its final user message is the
 * `COMPACTION_INSTRUCTION` constant of `@deepseek-ai/dsh-compaction-basic`
 * (copied, not imported, like the prune line): a tool-bearing request whose
 * last user text starts with this sentence. The mock answers it from its own
 * lane, because a record reply is not a summary and would make the mount's
 * compaction commit junk.
 */
const COMPACTION_ASK_PREFIX = 'You are now acting as a compaction engine';
/** What every compaction row answers: a small, deterministic substitute summary. */
const COMPACTION_REPLY_TEXT = '## Primary Request and Intent\n'
  + '- (synthetic replay checkpoint: the record carries no prose)\n\n'
  + '## Next Step\n- (none)';
/** Rows answering the summarization ask; a queue, like the prune lane. */
const COMPACTION_REPLY_CEILING = 8;
/**
 * The row that answers the first main request AFTER the host rewrote the
 * conversation. A compaction replaces a span with one checkpoint message, so
 * `tool_results_count` drops and the message list is no longer the recorded
 * one: no record row can honestly answer it, and without this row the request
 * is a mock `no-match` (500), ending the arm on a provider error instead of on
 * an answer. It matches the checkpoint tag `compaction-basic` writes, and sits
 * AFTER the compaction rows: the summarization ask also quotes the tag inside
 * its instruction, so order is what keeps the ask on its own lane.
 */
const POST_COMPACTION_NAME = 'replay-post-compaction';
const POST_COMPACTION_TEXT = '<replay post-compaction: the host condensed the conversation; the record ends here>';
/** The tag `compaction-basic` wraps a committed checkpoint in. */
const CHECKPOINT_TAG = '<compacted-summary>';
/**
 * The host pruner row, why the racoons arm disables it, and why the vanilla arm
 * does not (ADR-0041; arm rule 2026-11-09).
 *
 * `tool-result-pruner` is the host's own tool-result trimmer. It rewrites older
 * tool results in place when the context is under pressure, which is the job the
 * product does, so a run with it mounted measures two mechanisms sharing the
 * work and no number says what the product removed alone. It also makes the
 * pressure mode's compaction row vacuous: `compaction-basic` calls
 * `toolResultPruner.pruneSession()` as soon as pressure is confirmed, then
 * re-measures, so a conversation whose pressure came from tool results is
 * trimmed to ~5,150 chars per result and drops back under the trigger
 * (`compaction-basic/lib/index.js`, the `if (prune !== void 0)` block).
 *
 * Owner ruling 2026-11-09: the state is ARM-DEPENDENT, because the two arms ask
 * two different questions. The racoons arm measures what the mount removed
 * alone, so the host pruner is disabled by the row below (ADR-0041) and a run
 * that logs a `compaction/prune` event fails. The vanilla arm measures the host
 * as shipped, so the launcher writes NO row for the pruner: the composed config
 * keeps the host's own default (on) and a `compaction/prune` event is the
 * control's legitimate work, accounted as its own lane. `--allow-host-pruner`
 * (or its older spelling `--end-pressure-isolation`) remains the racoons arm's
 * explicit opt-out; on the vanilla arm it is redundant and changes nothing.
 * Both states are recorded in `launch.json` and `result.json`.
 */
const HOST_PRUNER_ROW = ['- id: tool-result-pruner', '  disabled: true'];
/** The row id those two lines disable, named once for the gates and the record. */
const HOST_PRUNER_ID = 'tool-result-pruner';
/** The racoons arm's state: the launcher's row turns the host pruner off. */
const HOST_PRUNER_DISABLED = 'disabled';
/** The vanilla arm's state: no row is written; the host's own default stands. */
const HOST_PRUNER_HOST_DEFAULT = 'host-default';
/**
 * The host pruner state one arm runs under (owner ruling 2026-11-09).
 *
 * One rule for the patch, the launch record, the result record and both
 * assertions, so no artifact can state a state the patch did not write:
 *   - `racoons`: `disabled` — the mount is the only remover;
 *   - `vanilla`: `host-default` — the control leaves the host as shipped (on);
 *   - `racoons` with the ADR-0041 opt-out: `host-default`, not a product
 *     measurement (the flag is redundant on vanilla and stays a no-op there).
 * @param {'racoons'|'vanilla'} arm - the arm this run names.
 * @param {boolean} [allowHostPruner] - the ADR-0041 opt-out.
 * @returns {'disabled'|'host-default'}
 */
export function hostPrunerState(arm, allowHostPruner = false) {
  if (arm === 'vanilla') return HOST_PRUNER_HOST_DEFAULT;
  if (arm === 'racoons') return allowHostPruner ? HOST_PRUNER_HOST_DEFAULT : HOST_PRUNER_DISABLED;
  throw new Error(`bench-run.mjs: no host-pruner state for arm ${JSON.stringify(arm)}; `
    + '--arm must be racoons or vanilla');
}
/**
 * The one-row invariant (ADR-0041 decision 4): the composed patch carries the
 * disable row or nothing, never a disable row beside an enable row for the same
 * id. The launcher writes at most one copy, so this can only fire if a later
 * edit adds a second writer — which is exactly when it must fail loudly, before
 * the file reaches the host.
 * @param {string[]} rows - the composed patch lines.
 * @returns {number} how many `tool-result-pruner` row headers the patch carries.
 */
function hostPrunerRowCount(rows) {
  return rows.filter((line) => line.trim() === `- id: ${HOST_PRUNER_ID}`).length;
}
/**
 * The composed patch's own row tally, recorded in `result.json.hostPruner.patch`
 * so a reader can see the arm's state without trusting a boolean: the racoons
 * patch carries one more top-level row (the pruner disable row or the mount
 * insert) than the vanilla patch, and `hostPrunerRows` is 0 on vanilla.
 * Top-level entries only (`- id:` and `- insert:` at column 0); a nested row
 * inside an insert block is part of its parent entry and is not counted twice.
 * @param {string} text - `patch.yml` as written.
 * @returns {{rows: number, hostPrunerRows: number}}
 */
export function patchRowTally(text) {
  const lines = String(text).split(/\r?\n/u);
  return {
    rows: lines.filter((line) => /^- (?:id|insert):/u.test(line)).length,
    hostPrunerRows: lines.filter((line) => line.trim() === `- id: ${HOST_PRUNER_ID}`).length,
  };
}
/**
 * The `result.json.hostPruner` block: the arm's state, what the patch carried,
 * what the composed config says, and what the session log says the pruner did.
 * One builder so the artifact and its tests read the same fields.
 *
 * `state` is the arm rule's one word and `disabled` is derived from it, never
 * from the flag: a vanilla run records `disabled: false` even though its argv
 * may carry `--allow-host-pruner`, because the flag changed nothing there.
 * `patch` is the composed patch's own tally (what the launcher wrote);
 * `composed` is the `--dump-config` read-back (what the child mounted).
 * @param {{arm: 'racoons'|'vanilla', allowHostPruner?: boolean,
 *   endPressureIsolation?: boolean, patchTally: {rows: number, hostPrunerRows: number},
 *   isolation: {applied: boolean, source: string, rows: number, disabledRows: number,
 *     error: string|null}|null, pruneEvents: number, pruneShadowedTokens: number}} input
 * @returns {object}
 */
export function hostPrunerRecord({ arm, allowHostPruner = false, endPressureIsolation = false,
  patchTally, isolation, pruneEvents, pruneShadowedTokens }) {
  const state = hostPrunerState(arm, allowHostPruner);
  return {
    row: HOST_PRUNER_ID,
    arm,
    state,
    disabled: state === HOST_PRUNER_DISABLED,
    // The opt-out is a decision only when the flag changed the arm's default.
    optOut: allowHostPruner && arm === 'racoons'
      ? { flag: endPressureIsolation ? '--end-pressure-isolation' : '--allow-host-pruner',
        productMeasurement: false }
      : null,
    patch: { rows: patchTally.rows, hostPrunerRows: patchTally.hostPrunerRows },
    composed: isolation === null ? null : {
      applied: isolation.applied,
      source: isolation.source,
      rows: isolation.rows,
      disabledRows: isolation.disabledRows,
      ...(isolation.error === null ? {} : { error: isolation.error }),
    },
    pruneEvents,
    pruneShadowedTokens,
    asserted: state === HOST_PRUNER_DISABLED,
  };
}
/**
 * The host's compaction trigger, in tokens, for the route a mock replay uses.
 * `compaction-basic` fires at `floor(min(W × 0.8, W − O − B))`:
 *   W = 1,000,000   the `deepseek-flash` adapter's `DEFAULT_CONTEXT_WINDOW`
 *   O = 256,000     the request envelope's `maxTokens` (what the header reserves)
 *   B =  65,536     `headroomTokens`
 * so the trigger is `min(800,000, 678,464) = 678,464` — NOT 800,000, because the
 * completion reservation binds before the ratio does. It is recorded in
 * `result.json` for INFORMATION ONLY, on the host's own meter (`meter: 'host'`):
 * no gate compares a byte count to it. `body_bytes / BYTES_PER_TOKEN`
 * UNDERSTATES the host meter (the meter prices blocks, per-message framing and a
 * routed baseline), so a threshold built from bytes would false-fail a healthy
 * arm. The gates read `compaction/start` and `compaction/end` events instead;
 * `reference.md` carries the derivation.
 */
const PRESSURE_TRIGGER_TOKENS = 678_464;
/** Bytes-per-token density heuristic, used only to state a byte count as an
 * estimate beside the host's trigger. Never an assertion input. */
const BYTES_PER_TOKEN = 4;

/**
 * The eight rows of `subagent-deny.md`, verbatim. One file, deny last. The
 * header check in the deny probe reads what the model was actually offered, so
 * a drift between this list and the design file shows as a failed probe.
 */
const DENY_ROWS = [
  '# Bench law: no delegation. Both arms load this same row set, last.',
  '- id: tool-subagent',
  '  disabled: true          # removes `subagent`',
  '- id: tool-subagent-fork',
  '  disabled: true          # removes `subagent_fork`',
  '- id: tool-workflow',
  '  disabled: true          # removes `workflow`',
  '- id: tool-subagent-control',
  '  disabled: true          # removes `send_message`, `interrupt_agent`',
  '- id: tool-subagent-list-agents',
  '  disabled: true          # removes `list_agents`',
  '- id: subagent-spawn-in-process',
  '  disabled: true          # removes the `spawn` provider behind the tools',
  '- id: subagent-fork-in-process',
  '  disabled: true          # removes the `fork` provider',
  '- id: workflow-ptc',
  '  disabled: true          # removes the workflow PTC bridge',
];
/** The tool names the model must never be offered. */
const DENIED_TOOL_NAMES = ['subagent', 'subagent_fork', 'workflow', 'send_message', 'interrupt_agent', 'list_agents'];
/**
 * The restore tool's model-facing name, as the shipped adapter registers it
 * (`packages/adapters/dsh/src/tools.ts`). One home for the name in this file: the
 * mount's header row is read against it, so a rename on the product side fails
 * `dev/bench/tool-name.test.mjs` by name instead of failing a live run's row
 * (ISSUE-132; the rename to this name landed at `46b0d0b`, ISSUE-123).
 */
const RESTORE_TOOL_NAME = 'necromancy';
/** The eight row ids those names ride on; the static check reads them back. */
const DENY_ROW_IDS = [
  'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-subagent-control',
  'tool-subagent-list-agents', 'subagent-spawn-in-process', 'subagent-fork-in-process', 'workflow-ptc',
];
/**
 * Rows that can reach the OFFICIAL DeepSeek endpoint (`api.deepseek.com`) and
 * spend the owner's own credits. They never mount by default: `--allow-official-spend`
 * is the only way to re-open them, and it is honored only on a provider whose
 * base URL is the official host (owner ruling 2026-11-05: official is allowed
 * only when explicitly named; ISSUE-176 keeps the guard).
 *
 * Four routes existed in the composed config before this row set (verified by
 * `--dump-config` against dsh 0.2.1-rc.2):
 *
 *   - `web-search-deepseek` → `https://api.deepseek.com/anthropic/v1/messages`,
 *     one full model turn per search, key `DEEPSEEK_API_KEY` (`dsh-base` patch
 *     `web-search-deepseek`, `apiKeyEnv` at its :476).
 *   - `web-deepseek-api` → `https://api.deepseek.com/v1/tools/{search,fetch}`,
 *     key `DEEPSEEK_API_KEY` (same patch file, :481).
 *   - `llm-deepseek` → the `deepseek-official` provider on
 *     `https://api.deepseek.com/anthropic` (`dsh-llm-deepseek/lib/index.js`
 *     `PUBLIC_BASE_URL`), key `DEEPSEEK_API_KEY`. Latent on a real route — the
 *     default model is moved to the bench route — but any selection of that
 *     provider spends.
 *   - `llm-deepseek-account` → the `deepseek-account` provider, whose tokens are
 *     minted for the `api.deepseek.com` origin
 *     (`dsh-deepseek-account-platform` `inferenceOrigin` default).
 *
 * `web` and `tool-web` are disabled with them: `web` is the only thing that
 * selects those providers, and `tool-web` is what offers the model
 * `web_search`/`web_fetch`. Removing the providers alone would leave two tools
 * that fail at execution; removing the tools alone would leave the providers
 * mounted for anything else that asks. No bench record, brief or fixture calls
 * either tool, so the bench loses no work surface.
 *
 * `web-fetch-http` stays: it is an anonymous public-HTTP fetch with no
 * credential and no official endpoint, and it is unreachable once `web` is gone.
 */
const OFFICIAL_ROUTE_ROWS = [
  '# Bench law: no official DeepSeek endpoint. Both arms load this same row set.',
  '- id: web-search-deepseek',
  '  disabled: true          # Messages search -> api.deepseek.com, DEEPSEEK_API_KEY',
  '- id: web-deepseek-api',
  '  disabled: true          # Search/Fetch API -> api.deepseek.com/v1/tools',
  '- id: web',
  '  disabled: true          # the service that selects those providers',
  '- id: tool-web',
  '  disabled: true          # removes `web_search`, `web_fetch`',
  '- id: llm-deepseek-account',
  '  disabled: true          # account tokens are minted for api.deepseek.com',
];
/** The six row ids above; the preflight reads them back from the dump. */
const OFFICIAL_ROUTE_IDS = [
  'web-search-deepseek', 'web-deepseek-api', 'web', 'tool-web', 'llm-deepseek-account', 'llm-deepseek',
];
/**
 * The four rows that OFFER the model web search/fetch. They are denied on every
 * run by default (`OFFICIAL_ROUTE_ROWS`), but `--allow-official-spend` skips
 * that row set because the flag authorizes the HOST, not a chosen row — so an
 * authorized official run re-opens them unless the run says otherwise.
 *
 * `--deny-web` is that say: it writes the four disable rows AFTER every row the
 * opt-in may have opened (later rows win per row id), so the four tools are
 * never offered even on an authorized official route. It does not touch
 * `llm-deepseek-account` or `llm-deepseek`: those are model transports, not the
 * web tools, and the official route's own transport must stay mounted.
 */
const WEB_ROUTE_IDS = ['web-search-deepseek', 'web-deepseek-api', 'web', 'tool-web'];
const WEB_DENY_ROWS = [
  '# Bench law: the four web tools are denied for this run (--deny-web).',
  '- id: web-search-deepseek',
  '  disabled: true          # Messages search -> api.deepseek.com',
  '- id: web-deepseek-api',
  '  disabled: true          # Search/Fetch API -> api.deepseek.com/v1/tools',
  '- id: web',
  '  disabled: true          # the service that selects those providers',
  '- id: tool-web',
  '  disabled: true          # removes `web_search`, `web_fetch`',
];
/**
 * The one row a provider choice legitimately leaves able to name the official
 * endpoint, or null when the choice permits none.
 *
 * `llm-pi-ai` is the route's own transport: on `deepseek-official` and
 * `deepseek-v4-pro` its baseURL IS `api.deepseek.com` and its key IS
 * `DEEPSEEK_API_KEY`, because that is what naming those providers asks for.
 * `llm-deepseek` is the mock lanes' transport: the loopback mock speaks through
 * it via `DEEPSEEK_BASE_URL` (a `127.0.0.1` origin) with the dummy key, so the
 * row must stay mounted or a mock run has no provider at all.
 *
 * Every other provider permits nothing: a provider this table does not name
 * gets no exempt row, so the official endpoint stays closed to it.
 * @param {string} provider
 * @returns {string|null}
 */
function officialRouteExemption(provider) {
  if (provider === 'deepseek-official' || provider === 'deepseek-v4-pro') return 'llm-pi-ai';
  if (MOCK_PROVIDERS.has(provider)) return 'llm-deepseek';
  return null;
}
/**
 * The real route this provider names when its base URL is the OFFICIAL DeepSeek
 * host, or null when the route cannot reach it.
 *
 * Derived from `REAL_ROUTES` rather than a hand-kept provider list: a future
 * route added with an `api.deepseek.com` base URL is covered by the opt-in
 * without another edit here. The mock lanes return null — their `DEEPSEEK_BASE_URL`
 * is a loopback origin, whatever the base row's adapter defaults to.
 * @param {string} provider
 * @returns {{provider: string, endpoint: string, apiKeyEnv: string}|null}
 */
function officialRouteFor(provider) {
  const route = REAL_ROUTES[provider];
  if (route === undefined) return null;
  let host = null;
  try {
    host = new URL(route.baseURL).hostname;
  } catch {
    host = null;
  }
  return host === 'api.deepseek.com'
    ? { provider, endpoint: route.baseURL, apiKeyEnv: route.apiKeyEnv }
    : null;
}
/**
 * The one refusal a run that names an official provider without the opt-in
 * gets. It names the flag, because the remedy is to type it.
 * @param {string} provider
 * @param {{endpoint: string}} official
 * @returns {string}
 */
function officialSpendRefusal(provider, official) {
  return `bench-run.mjs: --provider ${provider} reaches the official DeepSeek endpoint `
    + `(${official.endpoint}) and would spend the owner's official credits; pass `
    + '--allow-official-spend to authorize it (off by default, so a forgotten flag spends nothing)';
}
/**
 * The authorization block both artifacts carry when the flag opened an official
 * route. One shape, so `launch.json` and `result.json` can never disagree about
 * what was authorized.
 * @param {{provider: string, endpoint: string, apiKeyEnv: string}} official
 * @returns {object}
 */
function officialAuthorizationRecord(official) {
  return {
    provider: official.provider,
    endpoint: official.endpoint,
    apiKeyEnv: official.apiKeyEnv,
    spend: 'authorized',
    authorizedBy: '--allow-official-spend',
    ruling: 'owner ruling 2026-11-05: official is allowed only when explicitly named',
  };
}
/**
 * The `deepseek-official` provider row, disabled on every REAL route unless the
 * run opted in with `--allow-official-spend` and the provider itself is official.
 *
 * It is NOT disabled on the mock lanes: `llm-deepseek` IS the mock transport
 * there. The base patch's `agent-default-model` names `deepseek-official`, and
 * the mock lane reaches the loopback mock through `DEEPSEEK_BASE_URL`. Removing
 * the row would leave a mock run with no provider at all.
 */
const OFFICIAL_LLM_ROW = [
  '- id: llm-deepseek',
  '  disabled: true          # `deepseek-official` provider -> api.deepseek.com',
];
/** A mock must never dirty a real arm; absent from a copy is a copy bug. */
const NOT_COPIED = new Set(['manifest.json']);
/** Defensive: the frozen arm already excludes these. */
const EXCLUDED_DIR_NAMES = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'wheels', 'build', 'dist', 'out', 'target',
  'scratchpad', '.worktrees', '__pycache__', '.pytest_cache',
]);
/** The projection's own schema tag. A stored file naming another tag is a
 * different mechanism, not a drifted baseline. */
const PROJECTION_SCHEMA = 'racoons-bench-projection/1';

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const BENCH_RUN_OPTIONS = optionsOf([
  ['--arm', 'string'],
  ['--provider', 'string'],
  ['--root', 'string'],
  ['--arm-dir', 'string', 'armDir'],
  ['--brief', 'string'],
  ['--resume', 'string'],
  ['--task-file', 'string', 'taskFile'],
  ['--deliverables', 'string'],
  ['--manifest', 'string'],
  ['--mock-script', 'string', 'mockScript'],
  ['--record', 'string'],
  ['--record-map', 'string', 'recordMap'],
  ['--plugin-dist', 'string', 'pluginDist'],
  ['--plugin-entry', 'string', 'pluginEntry'],
  ['--pwsh-guard', 'string', 'pwshGuard'],
  ['--kill-ms', 'string', 'killMs'],
  ['--token-grant', 'string', 'tokenGrant'],
  ['--stop-on-compaction', 'boolean', 'stopOnCompaction'],
  ['--stop-at-checkpoint', 'string', 'stopAtCheckpoint'],
  ['--stop-after-compactions', 'string', 'stopAfterCompactions'],
  ['--deny-web', 'boolean', 'denyWeb'],
  ['--workspace-only', 'boolean', 'workspaceOnly'],
  ['--allow-official-spend', 'boolean', 'allowOfficialSpend'],
  ['--port', 'string'],
  ['--evidence', 'string'],
  ['--dsh-bin', 'string', 'dshBin'],
  ['--dry-work', 'boolean', 'dryWork'],
  ['--expect-exit', 'string', 'expectExit'],
  ['--require-done', 'boolean', 'requireDone'],
  ['--omit-deny-rows', 'boolean', 'omitDenyRows'],
  ['--preflight', 'boolean'],
  ['--projection-out', 'string', 'projectionOut'],
  ['--projection-in', 'string', 'projectionIn'],
  ['--perturb-swap-match', 'string', 'perturbSwapMatch'],
  ['--perturb-journal-caps', 'string', 'perturbJournalCaps'],
  ['--perturb-journal-parse', 'boolean', 'perturbJournalParse'],
  ['--inflate-bytes', 'string', 'inflateBytes'],
  ['--window-tokens', 'string', 'windowTokens'],
  ['--host-window-tokens', 'string', 'hostWindowTokens'],
  ['--prune-threshold-tokens', 'string', 'pruneThresholdTokens'],
  ['--entry-ask-batch-size', 'string', 'entryAskBatchSize'],
  ['--entry-ask-trigger', 'string', 'entryAskTrigger'],
  ['--entry-ask-grammar', 'string', 'entryAskGrammar'],
  ['--prune-ask-grammar', 'string', 'pruneAskGrammar'],
  ['--dedupe-superseded-by-reread', 'boolean', 'dedupeSupersededByReread'],
  ['--dedupe-call-echo', 'boolean', 'dedupeCallEcho'],
  ['--judge-timeout-ms', 'string', 'judgeTimeoutMs'],
  ['--allow-host-pruner', 'boolean', 'allowHostPruner'],
  ['--end-pressure-isolation', 'boolean', 'endPressureIsolation'],
  ['--allow-zero-reasoning', 'boolean', 'allowZeroReasoning'],
  ['--world', 'string'],
  ['--allow-read', 'string', 'allowRead', { multiple: true }],
  ['--allow-tool-root', 'string', 'allowToolRoots', { multiple: true }],
]);

const BENCH_RUN_HELP = 'usage: bench-run.mjs --arm <racoons|vanilla> [--provider mock|mock-replay|deepseek-official|deepseek-v4-pro] [--allow-official-spend] [--dry-work]\n'
  + '       [--root <bench-root>] [--arm-dir <path>] [--brief <file>]\n'
  + '       [--resume <evidence dir>]  # continue the session persisted in this evidence\n'
  + '                              # dir instead of starting over: nothing is wiped,\n'
  + '                              # result.json/stdout.ndjson move to\n'
  + '                              # <evidence>/round-N/, the session id is read from\n'
  + '                              # <evidence>/sessions (exactly one log), and the\n'
  + '                              # child gets --session-id. Needs --task-file. The\n'
  + '                              # brief task-hash and arm-tree manifest gates are\n'
  + '                              # skipped (the task is new; the arm holds prior\n'
  + '                              # deliverables), and the round must write the\n'
  + '                              # deliverables that were missing before it. The\n'
  + '                              # task file\'s own final list names them; no list\n'
  + '                              # keeps the thirteen defaults and marks the gate\n'
  + '                              # not-applicable\n'
  + '       [--task-file <file>]   # --resume only: the follow-up task, read raw (no\n'
  + '                              # fence and no length cap; both task channels\n'
  + '                              # reach dsh on stdin, not argv).\n'
  + '       [--deliverables <file>]  # expected deliverable paths, one per line (or\n'
  + '                              # JSON); overrides the brief-derived list. The\n'
  + '                              # default is the brief\'s final explicit path\n'
  + '                              # list, else the current thirteen files\n'
  + '       [--kill-ms <n>]        # optional wall-clock cap, default 0 (off; the\n'
  + '                              # token grant is the only cap). A positive value\n'
  + '                              # arms taskkill before any wait; a negative value\n'
  + '                              # or a fraction refuses\n'
  + '       [--manifest <file>]     # round manifest under dev/bench/manifests/: the brief\'s\n'
  + '                              # fence sha256 and block size must match its `brief` block,\n'
  + '                              # and the arm\'s multiset its `image.digest`; exit 2 otherwise\n'
  + '       [--token-grant <n>]    # in-run spend ceiling in TRUE tokens: main prompt\n'
  + '                              # + main output + ask input + ask output (the sum\n'
  + '                              # the watchdog compares, from the session log and\n'
  + '                              # the mount journal); at or past the grant the tree\n'
  + '                              # is killed. The flag sets the ceiling for this run\n'
  + '                              # only: no default cap is implied (the launcher\n'
  + '                              # applies none of its own; absent = no ceiling, and\n'
  + '                              # a paid provider without the flag is refused)\n'
  + '       [--stop-on-compaction]  # stop at the session\'s FIRST native compaction\n'
  + '                              # (compaction/start), not a budget: the tree is\n'
  + '                              # killed through the same path the box uses, the run\n'
  + '                              # is labelled stopped-on-compaction (exit 1, never\n'
  + '                              # green), and result.json carries the step, seq and\n'
  + '                              # billed total at the crossing; off when absent\n'
  + '       [--stop-at-checkpoint <relative path>]  # stop when this file appears under\n'
  + '                              # the arm dir (the agent\'s working directory): a\n'
  + '                              # CENSORED PARTIAL, exit 1, name stopped-at-checkpoint,\n'
  + '                              # result.json.stop.censored true; the path must be\n'
  + '                              # relative, must not contain .., and must be absent at\n'
  + '                              # launch. Off when absent\n'
  + '       [--stop-after-compactions <n>]  # stop at the Nth native compaction; same\n'
  + '                              # censored-partial rule, name stopped-after-compactions.\n'
  + '                              # Whichever of this and --stop-at-checkpoint fires first\n'
  + '                              # ends the run. n is a positive integer\n'
  + '       [--deny-web]          # deny `web`, `web-search-deepseek`, `web-deepseek-api`\n'
  + '                              # and `tool-web` even when --allow-official-spend opens\n'
  + '                              # the official host; preflight FAILS unless all four\n'
  + '                              # compose disabled\n'
  + '       [--workspace-only]    # the arm\'s world is the only readable root: any tool\n'
  + '                              # call naming a path outside it fails the run (exit 4);\n'
  + '                              # cannot be combined with --allow-read (but\n'
  + '                              # --allow-tool-root is allowed)\n'
  + '       [--allow-official-spend]  # REQUIRED for --provider deepseek-official and\n'
  + '                              # deepseek-v4-pro (any route whose base URL is\n'
  + '                              # api.deepseek.com): authorizes spending the owner\'s\n'
  + '                              # official credits. Off by default; without it those\n'
  + '                              # providers refuse, a --preflight FAILS, and every\n'
  + '                              # official route row stays disabled. No effect on\n'
  + '                              # the mock lanes.\n'
  + '       [--mock-script <file>] [--record <transcript.jsonl>] [--record-map <map.json>]\n'
  + '       [--port <n>] [--plugin-dist <dir>] [--plugin-entry <file>]\n'
  + '       [--evidence <dir>] [--dsh-bin <bin.js>] [--expect-exit <n>] [--require-done]\n'
  + '       [--projection-out <file>|--projection-in <file>]  # mock-replay determinism gate\n'
  + '       [--perturb-swap-match i,j]  # mock-replay perturbation: must fail by name\n'
  + '       [--perturb-journal-caps <n>]  # shift the journal cap count; must fail by name\n'
  + '       [--perturb-journal-parse]     # append a non-JSON line to the journal; must fail\n'
  + '       [--inflate-bytes <n>]  # mock-replay: pad every scripted shell result to >= n bytes\n'
  + '                              # with deterministic filler (synthetic pressure; see runbook)\n'
  + '       [--pwsh-guard <exe>]  # run every pwsh call through this wrapper;\n'
  + '                              # it refuses commands naming paths outside the\n'
  + '                              # workspace as a normal tool error (live shell\n'
  + '                              # boundary, ISSUE-297)\n'
  + '       [--window-tokens <n>]  # racoons arm: mount contextWindowTokens (half-window prune\n'
  + '                              # trigger); default 400000 on a real provider (prune bar\n'
  + '                              # 200000, native backstop 400000); null on the mock lanes\n'
  + '                              # (trigger off)\n'
  + '       [--host-window-tokens <n>]  # real routes only: the dsh host\'s native\n'
  + '                              # compaction window on the llm-pi-ai model row\n'
  + '                              # (compaction-basic triggers at context −\n'
  + '                              # max(15%·context, 16000): 340000 at 400000,\n'
  + '                              # 170000 at 200000); default 400000; refused on\n'
  + '                              # the mock lanes\n'
  + '                              # (ADR-0050); the ADR-0050 test value is 60000. Independent\n'
  + '                              # of --window-tokens; absent = no bar, so the deprecated\n'
  + '                              # half-window rule stays in force\n'
  + '       [--entry-ask-batch-size <n>]  # racoons arm: mount entryAskBatchSize, the batched\n'
  + '                              # entry-ask cadence (one index-keyed ask per n eligible\n'
  + '                              # results; ADR-0035); absent or 1 = the shipped\n'
  + '                              # per-result ask\n'
  + '       [--entry-ask-trigger <spec>]  # racoons arm: mount entryAskTrigger; spec is\n'
  + '                              # landed-bytes:<bytes> (e.g. landed-bytes:240000), a\n'
  + '                              # positive safe integer, or \'{"mode":"off"}\', which turns\n'
  + '                              # the per-result ask off (ADR-0050 decision 4). Absent =\n'
  + '                              # count, the cadence above (ISSUE-128)\n'
  + '       [--entry-ask-grammar <g>]  # racoons arm: mount entryAskGrammar; jsonl-20 (the\n'
  + '                              # shipped default: one JSON object per row per line,\n'
  + '                              # row-local refusal; ADR-0040/ISSUE-183), 3option (the\n'
  + '                              # original contract) or two-option (no line-level option;\n'
  + '                              # a row that names lines is refused and keeps; ISSUE-129).\n'
  + '                              # Absent = jsonl-20\n'
  + '       [--prune-ask-grammar <g>]  # racoons arm: mount pruneAskGrammar; nokeepall (the\n'
  + '                              # shipped default: forgetall or keeplines only; a whole\n'
  + '                              # unit is a full-range keeplines with summary None;\n'
  + '                              # ISSUE-221) or 3option (the original bulk-prune contract,\n'
  + '                              # byte for byte). Absent = nokeepall\n'
  + '       [--dedupe-superseded-by-reread]  # racoons arm: mount dedupeSupersededByReread, the\n'
  + '                              # superseded-by-reread dedupe class (ADR-0037; ISSUE-145);\n'
  + '                              # off when absent, so only this flag puts true in the row\n'
  + '       [--dedupe-call-echo]      # racoons arm: mount dedupeCallEcho, the exact-echo subset\n'
  + '                              # of the call-echo dedupe class (ADR-0037; ISSUE-151); off\n'
  + '                              # when absent. A result carrying previous state is refused\n'
  + '                              # by name, never edited\n'
  + '       [--judge-timeout-ms <n>]  # racoons arm: mount judgeTimeoutMs, the deadline on\n'
  + '                              # the bulk-prune ask (prefill + generation); subject to\n'
  + '                              # the mount\'s own default (30000) when absent\n'
  + '       [--allow-host-pruner]  # racoons arm: leave the host\'s own tool-result\n'
  + '                              # pruner ON (opt-out). The racoons arm disables\n'
  + '                              # it by default so the mount is the only\n'
  + '                              # remover (ADR-0041); the vanilla arm always\n'
  + '                              # leaves it at the host default (on) and writes\n'
  + '                              # no row. A racoons run with it on is NOT a\n'
  + '                              # product measurement\n'
  + '       [--end-pressure-isolation]  # the same choice under its older spelling:\n'
  + '                              # leave the host tool-result pruner ON; still needs\n'
  + '                              # --inflate-bytes (ADR-0041)\n'
  + '       [--allow-zero-reasoning]  # explicit void flag: a measurement run whose\n'
  + '                              # session carries no reasoning (or falls below the\n'
  + '                              # declared coverage floor) may proceed, but\n'
  + '                              # result.json.citableAs says "none (no reasoning\n'
  + '                              # measured)" and the comparison is void (ADR-0045)\n'
  + '       [--world <dir>]        # read boundary (ISSUE-039): the arm and --evidence must\n'
  + '                              # live under this dir, and the campaign (its parent) is\n'
  + '                              # read-denied; see runbook.md Step 3\n'
  + '       [--allow-read <dir>]   # read boundary: this dir may be READ (repeatable) and must\n'
  + '                              # not be written; the template checkout goes here\n'
  + '       [--allow-tool-root <dir>]  # read boundary: a dir the run\'s TOOLS may reach\n'
  + '                              # (repeatable): the deps-only venv interpreter goes here\n'
  + '                              # (ISSUE-297). Permitted with --workspace-only; every\n'
  + '                              # other outside path still fails that run\n'
  + '       [--preflight]         # resolve + dump-config only; spends nothing\n'
  + '       [--omit-deny-rows]    # perturbation: the probe must FAIL; never a bench run\n';

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: BENCH_RUN_OPTIONS,
    refuse,
    help: BENCH_RUN_HELP,
    prefix: 'bench-run.mjs: ',
  });
  const opts = {
    arm: values.arm ?? null,
    provider: values.provider ?? 'mock',
    root: values.root ?? DEFAULTS.root,
    armDir: values.armDir ?? null,
    brief: values.brief ?? DEFAULTS.brief,
    resume: values.resume ?? null,
    taskFile: values.taskFile ?? null,
    deliverables: values.deliverables ?? null,
    manifest: values.manifest ?? null,
    mockScript: values.mockScript ?? DEFAULTS.mockScript,
    record: values.record ?? null,
    recordMap: values.recordMap ?? null,
    pluginDist: values.pluginDist ?? DEFAULTS.pluginDist,
    pluginEntry: values.pluginEntry ?? null,
    pwshGuard: values.pwshGuard ?? null,
    killMs: values.killMs ?? DEFAULTS.killMs,
    tokenGrant: values.tokenGrant ?? null,
    stopOnCompaction: values.stopOnCompaction ?? false,
    stopAtCheckpoint: values.stopAtCheckpoint ?? null,
    stopAfterCompactions: values.stopAfterCompactions ?? null,
    denyWeb: values.denyWeb ?? false,
    workspaceOnly: values.workspaceOnly ?? false,
    allowOfficialSpend: values.allowOfficialSpend ?? false,
    port: values.port ?? '0',
    evidence: values.evidence ?? null,
    dshBin: values.dshBin ?? null,
    dryWork: values.dryWork ?? false,
    expectExit: values.expectExit ?? '0',
    requireDone: values.requireDone ?? false,
    omitDenyRows: values.omitDenyRows ?? false,
    preflight: values.preflight ?? false,
    projectionOut: values.projectionOut ?? null,
    projectionIn: values.projectionIn ?? null,
    perturbSwapMatch: values.perturbSwapMatch ?? null,
    perturbJournalCaps: values.perturbJournalCaps ?? null,
    perturbJournalParse: values.perturbJournalParse ?? false,
    inflateBytes: values.inflateBytes ?? null,
    windowTokens: values.windowTokens ?? null,
    hostWindowTokens: values.hostWindowTokens ?? null,
    pruneThresholdTokens: values.pruneThresholdTokens ?? null,
    entryAskBatchSize: values.entryAskBatchSize ?? null,
    entryAskTrigger: values.entryAskTrigger ?? null,
    entryAskGrammar: values.entryAskGrammar ?? null,
    pruneAskGrammar: values.pruneAskGrammar ?? null,
    dedupeSupersededByReread: values.dedupeSupersededByReread ?? false,
    dedupeCallEcho: values.dedupeCallEcho ?? false,
    judgeTimeoutMs: values.judgeTimeoutMs ?? null,
    allowHostPruner: values.allowHostPruner ?? false,
    endPressureIsolation: values.endPressureIsolation ?? false,
    allowZeroReasoning: values.allowZeroReasoning ?? false,
    world: values.world ?? null,
    allowRead: values.allowRead ?? [],
    allowToolRoots: values.allowToolRoots ?? [],
  };
  if (opts.arm !== 'racoons' && opts.arm !== 'vanilla') refuse('bench-run.mjs: --arm must be racoons or vanilla');
  if (!PROVIDERS.has(opts.provider)) refuse('bench-run.mjs: --provider must be mock, mock-replay, deepseek-official or deepseek-v4-pro');
  // A resume names the evidence dir it continues; it is not a second way to
  // name a run. The follow-up task is new text, so `--brief` is not read and
  // `--task-file` is required — an absent task would resume the session with
  // the old brief's words, which is the opposite of a follow-up.
  if (opts.resume !== null) {
    if (opts.preflight) {
      refuse('bench-run.mjs: --resume cannot be combined with --preflight (a preflight is not a round, '
        + 'and it must not archive the evidence dir it inspects)');
    }
    if (opts.taskFile === null) {
      refuse('bench-run.mjs: --resume needs --task-file <file>: the follow-up task is new text, '
        + 'not the brief the previous round ran');
    }
    if (opts.evidence !== null
      && !samePath(canonicalPath(opts.evidence), canonicalPath(opts.resume))) {
      refuse('bench-run.mjs: --resume names the evidence dir it continues; --evidence must be absent '
        + 'or name the same path');
    }
  } else if (opts.taskFile !== null) {
    refuse('bench-run.mjs: --task-file belongs to --resume (a normal round takes its task from --brief)');
  }
  const killMs = killMsValue(opts.killMs);
  if (!killMs.ok) refuse(killMs.message);
  opts.killMs = killMs.value;
  if (opts.tokenGrant !== null) {
    // The grant is a TRUE-TOTAL count: main prompt + main output + ask prompt
    // + ask output + the native compaction call's prompt and output. Main
    // prompt is input + cacheRead + cacheWrite, the sum `session-usage.mjs`
    // computes for the watchdog and the derivation; it is one of the six
    // streams of that total, never the total itself. Zero is
    // refused — it would kill the tree before the first step and make every
    // launch a timeout, which is a typo, not a budget.
    const grant = Number(opts.tokenGrant);
    if (!Number.isSafeInteger(grant) || grant < 1) {
      refuse('bench-run.mjs: --token-grant takes a positive integer true-total token count '
        + '(main prompt + main output + ask prompt + ask output + compaction prompt and output); '
        + '40000000 is an example only, '
        + 'not a recommended cap');
    }
    opts.tokenGrant = grant;
  }
  // Owner ruling 2026-11-08: the token budget is the only run cap. A paid
  // provider without one would run unbounded, so it is refused by name. The
  // mock providers are offline and may omit a budget.
  if (opts.provider !== 'mock' && opts.provider !== 'mock-replay' && opts.tokenGrant === null) {
    refuse('bench-run.mjs: a paid run needs --token-grant; the token budget is the only run cap '
      + '(e.g. 100000000)');
  }
  if (opts.stopAtCheckpoint !== null) {
    const checkpoint = checkpointPathValue(opts.stopAtCheckpoint);
    if (!checkpoint.ok) refuse(checkpoint.message);
    opts.stopAtCheckpoint = checkpoint.value;
  }
  if (opts.stopAfterCompactions !== null) {
    const limit = stopAfterCompactionsValue(opts.stopAfterCompactions);
    if (!limit.ok) refuse(limit.message);
    opts.stopAfterCompactions = limit.value;
  }
  if (opts.workspaceOnly && opts.allowRead.length > 0) {
    // Workspace-only is the strict read rule; an allow-listed root would make
    // the claim false before the run starts.
    refuse('bench-run.mjs: --workspace-only cannot be combined with --allow-read '
      + '(workspace-only means the arm world is the only readable root)');
  }
  if (opts.requireDone && (opts.stopAtCheckpoint !== null || opts.stopAfterCompactions !== null)) {
    // A checkpoint stop is a censored partial: the run ends before BENCH-DONE,
    // so requiring BENCH-DONE would fail the run for doing what it was told.
    refuse('bench-run.mjs: --require-done cannot be combined with a checkpoint or compaction stop; '
      + 'a censored partial never carries BENCH-DONE');
  }
  if (opts.judgeTimeoutMs !== null) {
    // The bulk prune's ask deadline is a racoons-arm mount key: the vanilla arm
    // has no mount, so the flag would describe an ask that never happens.
    if (opts.arm !== 'racoons') {
      refuse('bench-run.mjs: --judge-timeout-ms belongs to --arm racoons (the vanilla arm has no mount)');
    }
    // Absent leaves the key out of the mount config entirely, so the mount's own
    // default (120 s since ISSUE-126, `DEFAULT_ASK_TIMEOUT_MS`) applies and a run
    // only raises it.
    const ms = Number(opts.judgeTimeoutMs);
    if (!Number.isSafeInteger(ms) || ms < 1) {
      refuse('bench-run.mjs: --judge-timeout-ms takes a positive integer millisecond deadline (e.g. 120000)');
    }
    opts.judgeTimeoutMs = ms;
  }
  if (opts.pruneThresholdTokens !== null) {
    // ADR-0050: the prune bar is an absolute token count owned by the mount, so
    // the vanilla arm has nothing to configure. Absent leaves the key out of the
    // mount config: the old half-window rule around `--window-tokens` stays in
    // force (ADR-0050 decision 2 calls it a deprecated compatibility path), and
    // the launcher never invents a bar.
    if (opts.arm !== 'racoons') {
      refuse('bench-run.mjs: --prune-threshold-tokens belongs to --arm racoons (the vanilla arm has no mount)');
    }
    const tokens = Number(opts.pruneThresholdTokens);
    if (!Number.isSafeInteger(tokens) || tokens < 1) {
      refuse('bench-run.mjs: --prune-threshold-tokens takes a positive integer token count (e.g. 60000)');
    }
    opts.pruneThresholdTokens = tokens;
  }
  if (opts.entryAskBatchSize !== null) {
    // The batched entry-ask cadence is a racoons-arm mount key too: the vanilla
    // arm has no mount, so the flag would describe an ask that never happens.
    if (opts.arm !== 'racoons') {
      refuse('bench-run.mjs: --entry-ask-batch-size belongs to --arm racoons (the vanilla arm has no mount)');
    }
    // Absent leaves the key out of the mount config entirely, so the count
    // path's own default (1) applies when a run selects `{mode:"count"}`;
    // `1` is legal: it states that cadence explicitly.
    const size = Number(opts.entryAskBatchSize);
    if (!Number.isSafeInteger(size) || size < 1) {
      refuse('bench-run.mjs: --entry-ask-batch-size takes a positive integer batch size (e.g. 6)');
    }
    opts.entryAskBatchSize = size;
  }
  if (opts.entryAskTrigger !== null) {
    // The entry-ask trigger is a racoons-arm mount key too: the vanilla arm has
    // no mount, so the flag would describe an ask that never happens.
    if (opts.arm !== 'racoons') {
      refuse('bench-run.mjs: --entry-ask-trigger belongs to --arm racoons (the vanilla arm has no mount)');
    }
    // Two declared forms. `landed-bytes:<bytes>` is the landed-bytes trigger and
    // needs its positive threshold. `{"mode":"off"}` is ADR-0050 decision 4's off
    // switch: it needs no number, and it is written through unchanged so the
    // launch record states exactly what the run asked for. Count is the ABSENT
    // mode, and absent is how a run states it (the manifest shows no key).
    // Anything else refuses by name, naming the value it was given.
    const trimmed = opts.entryAskTrigger.trim();
    let spec = null;
    if (trimmed.startsWith('{')) {
      try { spec = JSON.parse(trimmed); } catch { spec = null; }
    }
    const off = spec !== null && typeof spec === 'object' && !Array.isArray(spec)
      && spec.mode === 'off' && Object.keys(spec).length === 1;
    if (off) {
      opts.entryAskTrigger = spec;
    } else {
      const landed = /^landed-bytes:(\d+)$/u.exec(opts.entryAskTrigger);
      const bytes = landed === null ? Number.NaN : Number(landed[1]);
      if (!Number.isSafeInteger(bytes) || bytes < 1) {
        refuse(`bench-run.mjs: --entry-ask-trigger does not take ${JSON.stringify(opts.entryAskTrigger)}: `
          + 'use landed-bytes:<bytes> with a positive safe integer (e.g. landed-bytes:240000) '
          + 'or {"mode":"off"} to turn the per-result ask off');
      }
      opts.entryAskTrigger = { mode: 'landed-bytes', bytes };
    }
  }
  if (opts.entryAskGrammar !== null) {
    // The ask grammar is the same racoons-arm mount key: the vanilla arm has no
    // ask. Absent writes the shipped default (`jsonl-20`) into the mount row.
    if (opts.arm !== 'racoons') {
      refuse('bench-run.mjs: --entry-ask-grammar belongs to --arm racoons (the vanilla arm has no mount)');
    }
    // Every shipped id is accepted by name (ADR-0040, ISSUE-183); the default is
    // written by `mountConfig`, so absent is never a silent mount default.
    if (opts.entryAskGrammar !== '3option' && opts.entryAskGrammar !== 'two-option'
      && opts.entryAskGrammar !== 'jsonl-20') {
      refuse(`bench-run.mjs: --entry-ask-grammar does not take ${JSON.stringify(opts.entryAskGrammar)}: `
        + 'use 3option, two-option or jsonl-20');
    }
  }
  if (opts.pruneAskGrammar !== null) {
    // The bulk prune grammar is the same racoons-arm mount key: the vanilla arm
    // has no prune pass. Absent writes the shipped default (`nokeepall`; ADR-0056)
    // into the mount row, so a launch record always names the contract it
    // measured.
    if (opts.arm !== 'racoons') {
      refuse('bench-run.mjs: --prune-ask-grammar belongs to --arm racoons (the vanilla arm has no mount)');
    }
    if (opts.pruneAskGrammar !== '3option' && opts.pruneAskGrammar !== 'nokeepall') {
      refuse(`bench-run.mjs: --prune-ask-grammar does not take ${JSON.stringify(opts.pruneAskGrammar)}: `
        + 'use 3option or nokeepall');
    }
  }
  for (const flag of ['dedupeSupersededByReread', 'dedupeCallEcho']) {
    // A dedupe class is a racoons-arm mount key too: the vanilla arm has no
    // mount, so the flag would describe a pass that never runs. Each is a pure
    // boolean — the parser refuses a value — and absent leaves the key out of
    // the mount config, so the entry's own default (off, ADR-0037 decision 6)
    // applies and only a flag turns the class on (ISSUE-163).
    if (opts[flag] && opts.arm !== 'racoons') {
      refuse(`bench-run.mjs: --${flag.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} belongs to --arm racoons (the vanilla arm has no mount)`);
    }
  }
  opts.port = Number(opts.port);
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) refuse('bench-run.mjs: --port must be 0..65535');
  opts.expectExit = Number(opts.expectExit);
  if (!Number.isSafeInteger(opts.expectExit)) refuse('bench-run.mjs: --expect-exit must be an integer');
  if (MOCK_PROVIDERS.has(opts.provider) && !opts.dryWork && !opts.preflight) {
    refuse(`bench-run.mjs: a ${opts.provider} run needs --dry-work (cwd is a copy under the evidence dir; `
      + 'a scripted model must never dirty a real arm)');
  }
  if (opts.omitDenyRows && !MOCK_PROVIDERS.has(opts.provider)) {
    refuse('bench-run.mjs: --omit-deny-rows is the mock perturbation only; a real run always carries the deny rows');
  }
  if (opts.provider === 'mock-replay') {
    if (opts.record === null) refuse('bench-run.mjs: --provider mock-replay needs --record <transcript.jsonl>');
    if (opts.recordMap === null) refuse('bench-run.mjs: --provider mock-replay needs --record-map <map.json> '
      + '(the map is what keeps every recorded path inside the arm)');
    if (opts.omitDenyRows) refuse('bench-run.mjs: --omit-deny-rows is a mock-smoke perturbation; mock-replay has no deny leg to perturb');
  } else if (opts.record !== null || opts.recordMap !== null) {
    refuse('bench-run.mjs: --record and --record-map belong to --provider mock-replay');
  }
  if (opts.projectionOut !== null || opts.projectionIn !== null) {
    // A real run has no recorded script to project and a mock-smoke run's script
    // is a checked-in fixture, so the gate would compare a constant to itself.
    if (opts.provider !== 'mock-replay') {
      refuse('bench-run.mjs: --projection-out/--projection-in belong to --provider mock-replay');
    }
    if (opts.projectionOut !== null && opts.projectionIn !== null) {
      refuse('bench-run.mjs: --projection-out and --projection-in cannot be combined (write, then compare on the next run)');
    }
    if (opts.projectionOut !== null && (opts.stopOnCompaction || opts.stopAtCheckpoint !== null
      || opts.stopAfterCompactions !== null)) {
      // A stopped run is never green, so a baseline written from one would bake
      // its half-replay into every later comparison (the same law that keeps a
      // perturbed run out of `--projection-out`). The read side is fine: a stop
      // run compared to a stored baseline reports the diffs of its prefix.
      const stopFlag = opts.stopOnCompaction ? '--stop-on-compaction'
        : opts.stopAtCheckpoint !== null ? '--stop-at-checkpoint' : '--stop-after-compactions';
      refuse(`bench-run.mjs: ${stopFlag} may not write a baseline (--projection-out); `
        + 'a baseline must come from a run that completed');
    }
  }
  if (opts.projectionIn !== null) {
    opts.projectionIn = resolve(opts.projectionIn);
    if (!existsSync(opts.projectionIn)) {
      refuse(`bench-run.mjs: --projection-in not found at ${opts.projectionIn}; `
        + 'that file comes from an earlier --projection-out run');
    }
  }
  if (opts.perturbJournalCaps !== null) {
    // Same law as --perturb-swap-match: this run can only be red, so it may not
    // become a baseline and it must be a mock-replay run (that is where a
    // journal exists to perturb).
    if (opts.provider !== 'mock-replay') {
      refuse('bench-run.mjs: --perturb-journal-caps belongs to --provider mock-replay');
    }
    if (opts.projectionOut !== null) {
      refuse('bench-run.mjs: --perturb-journal-caps may not write a baseline (--projection-out); '
        + 'a perturbed run is a red run by design');
    }
    const delta = Number(opts.perturbJournalCaps);
    if (!Number.isSafeInteger(delta) || delta === 0) {
      refuse('bench-run.mjs: --perturb-journal-caps takes a non-zero integer (e.g. 1 or -1)');
    }
    opts.perturbJournalCaps = delta;
  }
  if (opts.perturbJournalParse) {
    // Same law: the parse gate's perturbation can only produce a red run, so it
    // may not become a baseline and it needs a journal to spoil.
    if (opts.provider !== 'mock-replay') {
      refuse('bench-run.mjs: --perturb-journal-parse belongs to --provider mock-replay');
    }
    if (opts.projectionOut !== null) {
      refuse('bench-run.mjs: --perturb-journal-parse may not write a baseline (--projection-out); '
        + 'a perturbed run is a red run by design');
    }
  }
  if (opts.perturbSwapMatch !== null) {
    // The perturbation breaks the served script; it can only ever prove a gate
    // can fail, so it may not become a baseline and may not run off a record.
    if (opts.provider !== 'mock-replay') {
      refuse('bench-run.mjs: --perturb-swap-match belongs to --provider mock-replay');
    }
    if (opts.projectionOut !== null) {
      refuse('bench-run.mjs: --perturb-swap-match may not write a baseline (--projection-out); '
        + 'a perturbed run is a red run by design');
    }
    const slots = String(opts.perturbSwapMatch).split(',').map((part) => Number(part.trim()));
    if (slots.length !== 2 || !slots.every((n) => Number.isInteger(n) && n >= 1)) {
      refuse('bench-run.mjs: --perturb-swap-match takes two 1-based reply numbers, e.g. 3,4');
    }
    if (slots[0] === slots[1]) refuse('bench-run.mjs: --perturb-swap-match needs two different replies');
    opts.perturbSwapMatch = slots;
  }
  if (opts.inflateBytes !== null) {
    // Synthetic pressure is a mock-replay measuring instrument, not a bench
    // configuration: it changes what tool results the model sees, so it may
    // never reach a real run or a checked-in fixture.
    if (opts.provider !== 'mock-replay') {
      refuse('bench-run.mjs: --inflate-bytes belongs to --provider mock-replay '
        + '(synthetic pressure pads scripted shell results; a real run has no script)');
    }
    const bytes = Number(opts.inflateBytes);
    if (!Number.isSafeInteger(bytes) || bytes < 1) {
      refuse('bench-run.mjs: --inflate-bytes takes a positive integer byte count (e.g. 80000)');
    }
    // A target below one filler line cannot be met honestly; the loop would
    // print one row and the flag would claim a size it never delivered.
    if (bytes < FILLER_MIN_LINE) {
      refuse(`bench-run.mjs: --inflate-bytes ${String(bytes)} is below one filler line `
        + `(${String(FILLER_MIN_LINE)} B); nothing to add`);
    }
    opts.inflateBytes = bytes;
  }
  if (opts.windowTokens !== null) {
    // The mount's half-window trigger is a racoons-arm instrument: the vanilla
    // arm has no mount, so the flag would describe a mount that is not there.
    if (opts.arm !== 'racoons') {
      refuse('bench-run.mjs: --window-tokens belongs to --arm racoons (the vanilla arm has no mount)');
    }
    const tokens = Number(opts.windowTokens);
    if (!Number.isSafeInteger(tokens) || tokens < 1) {
      refuse('bench-run.mjs: --window-tokens takes a positive integer token count (e.g. 400000)');
    }
    opts.windowTokens = tokens;
  } else if (REAL_PROVIDERS.has(opts.provider) && opts.arm === 'racoons') {
    // Owner clarification 2026-10-24 (ISSUE-035): the real route arms the mount
    // at the host's native 400 000 window even when the flag is omitted, so the
    // half-window prune bar is the owner's 200 000 and the native backstop is
    // 400 000. A real arm left with the shipped `null` never prunes (the round-1
    // defect this exists to close), and a 60 000 window forced the host's
    // compaction at ~103 k billed, measuring the backstop instead of the prune.
    // Mock lanes keep `null`: their thresholds are the fixtures' own values.
    opts.windowTokens = REAL_ROUTE_WINDOW_TOKENS;
  }
  if (opts.hostWindowTokens !== null) {
    // The host's native compaction window is a real-route instrument: the mock
    // lanes serve scripted turns and never compact, so the flag would describe
    // a window nothing reads (the same shape as `--window-tokens` on vanilla).
    if (MOCK_PROVIDERS.has(opts.provider)) {
      refuse('bench-run.mjs: --host-window-tokens belongs to a real provider '
        + '(the mock lanes have no host compaction window)');
    }
    const tokens = Number(opts.hostWindowTokens);
    if (!Number.isSafeInteger(tokens) || tokens < 1) {
      refuse('bench-run.mjs: --host-window-tokens takes a positive integer token count (e.g. 200000)');
    }
    opts.hostWindowTokens = tokens;
  } else if (REAL_PROVIDERS.has(opts.provider)) {
    // ISSUE-291: a real route always states its host window, so the model row
    // carries the default 400 000 without any flag. Mock lanes keep `null`.
    opts.hostWindowTokens = HOST_WINDOW_TOKENS;
  }
  if (opts.endPressureIsolation && opts.inflateBytes === null) {
    // The flag exists to leave the host pruner ON. Its older spelling belonged to
    // the synthetic-pressure instrument, so it keeps that instrument's
    // precondition: with no pressure there is no isolation to end.
    refuse('bench-run.mjs: --end-pressure-isolation needs --inflate-bytes (there is no pressure isolation to end)');
  }
  // ADR-0041: leaving the host's competing pruner on is ONE choice under two
  // spellings. Folding them here is what guarantees the composed patch can never
  // carry a disable row and an enable row for the same id: `writePatch` writes
  // the disable row only when this is false. `endPressureIsolation` is kept on
  // `opts` so the launch record can name the spelling that was used.
  if (opts.endPressureIsolation) opts.allowHostPruner = true;
  if (opts.projectionOut !== null) opts.projectionOut = resolve(opts.projectionOut);
  opts.root = resolve(opts.root);
  opts.armDir = resolve(opts.armDir ?? join(opts.root, `${opts.arm}-arm`));
  if (opts.world !== null) opts.world = resolve(opts.world);
  opts.allowRead = opts.allowRead.map((dir) => resolve(dir));
  opts.allowToolRoots = opts.allowToolRoots.map((dir) => resolve(dir));
  opts.brief = resolve(opts.brief);
  if (opts.resume !== null) opts.resume = resolve(opts.resume);
  if (opts.taskFile !== null) opts.taskFile = resolve(opts.taskFile);
  if (opts.deliverables !== null) opts.deliverables = resolve(opts.deliverables);
  if (opts.manifest !== null) opts.manifest = resolve(opts.manifest);
  opts.mockScript = resolve(opts.mockScript);
  if (opts.record !== null) opts.record = resolve(opts.record);
  if (opts.recordMap !== null) opts.recordMap = resolve(opts.recordMap);
  opts.pluginDist = resolve(opts.pluginDist);
  if (opts.pluginEntry !== null) opts.pluginEntry = resolve(opts.pluginEntry);
  // The pwsh guard is the live shell boundary (ISSUE-297): a wrapper that
  // refuses commands naming paths outside the workspace before pwsh runs them.
  // It is named per run so the artifact records the exact executable.
  if (opts.pwshGuard !== null) {
    opts.pwshGuard = resolve(opts.pwshGuard);
    if (!existsSync(opts.pwshGuard)) {
      refuse(`bench-run.mjs: --pwsh-guard ${opts.pwshGuard} does not exist`);
    }
  }
  return opts;
}

/** The task text: the first fenced block under `## Task text`, byte-for-byte. */
function readBrief(file) {
  if (!existsSync(file)) refuse(`bench-run.mjs: brief not found at ${file}`);
  const text = readFileSync(file, 'utf8');
  const at = text.search(/^## Task text[ \t]*$/mu);
  if (at < 0) refuse(`bench-run.mjs: ${file} has no "## Task text" heading`);
  const fence = text.slice(at).match(/```[a-z]*\r?\n([\s\S]*?)\r?\n```/u);
  if (fence === null) refuse(`bench-run.mjs: ${file} has no fenced block under "## Task text"`);
  const task = fence[1].trim();
  if (task === '') refuse(`bench-run.mjs: ${file} names an empty task`);
  // No length cap: the task reaches dsh on stdin (`-`), not as one argv
  // element, so the Windows command-line limit no longer applies.
  return { task, text };
}

/** `true` when both paths name the same file after `resolve` (case-insensitive on Windows). */
function sameResolvedPath(left, right) {
  return samePath(left, right);
}

/**
 * The canonical (realpath) form of a path, or the resolved path with the
 * nearest existing ancestor realpathed. A junction or symlink is followed, so a
 * narrow evidence or allow-read root cannot be a link into a forbidden tree.
 * @param {string} path
 * @returns {string}
 */
export function canonicalPath(path) {
  let current = resolve(path);
  const suffix = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return suffix.length === 0 ? real : join(real, ...suffix.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      suffix.push(basename(current));
      current = parent;
    }
  }
}

/** `true` when `dir` exists and holds at least one entry. */
function nonEmptyDirectory(dir) {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Why an evidence directory may not be written, or null. The first rule is the
 * one the 1d incident needed: the directory must be strictly under this repo's
 * `scratchpad/`, canonicalized so a link cannot claim to be. The second is that
 * a wipe must never reach the arm or the world that holds it.
 * @param {{evidenceDir: string, scratchpad?: string, armDir?: string|null,
 *   world?: string|null, canonical?: (path: string) => string}} input
 * @returns {string|null}
 */
export function evidenceDirRefusal({ evidenceDir, scratchpad = SCRATCHPAD, armDir = null,
  world = null, canonical = canonicalPath }) {
  if (typeof evidenceDir !== 'string' || evidenceDir.trim() === '') {
    return 'the evidence dir needs a path';
  }
  const target = canonical(evidenceDir);
  const scratch = canonical(scratchpad);
  if (sameResolvedPath(target, scratch) || !pathInside(scratch, target)) {
    return `--evidence/--resume must live under ${scratch} (got ${target}); `
      + 'a launch never writes evidence into a new Desktop folder or another tree';
  }
  if (armDir !== null && armDir !== undefined) {
    const arm = canonical(armDir);
    if (sameResolvedPath(target, arm) || pathInside(target, arm) || pathInside(arm, target)) {
      return `the evidence dir ${target} overlaps the arm ${arm}; the arm is the measured world, not evidence`;
    }
  }
  if (world !== null && world !== undefined) {
    const worldRoot = canonical(world);
    if (sameResolvedPath(target, worldRoot) || pathInside(target, worldRoot)) {
      return `the evidence dir ${target} is the world root or contains it (${worldRoot}); `
        + 'a wipe would delete the measured world';
    }
    if (!pathInside(worldRoot, target)) {
      return `the evidence dir ${target} is outside the world ${worldRoot}; `
        + 'leave --evidence at its default (<world>/evidence)';
    }
  }
  return null;
}

/** The home paths that are a credential store, never read material. */
function credentialReadPaths({ home = homedir(), env = process.env } = {}) {
  const paths = [
    join(home, '.dsh'),
    join(home, '.dsh', '.credentials.yaml'),
    join(home, '.config'),
    join(home, '.credentials'),
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.azure'),
    join(home, '.kube'),
    join(home, '.gnupg'),
    join(home, '.local', 'share', 'opencode'),
    join(home, '.local', 'share', 'opencode', 'auth.json'),
  ];
  for (const name of ['DSH_CREDENTIALS_PATH', 'RIG_CREDENTIALS_PATH']) {
    const value = env?.[name];
    if (typeof value === 'string' && value.length > 0) paths.push(resolve(value));
  }
  return paths;
}

/**
 * Why a directory may not be an `--allow-read` root, or null. A root is
 * refused when it is a drive root (the whole machine), this repo (the
 * instrument), the evidence dir, the work copy, the home tree, or any known
 * credential store — a path inside one of those would make the run's read
 * record untrue before it starts.
 * @param {{root: string, repoRoot?: string, evidenceDir?: string|null,
 *   workDir?: string|null, home?: string, env?: Record<string, string|undefined>,
 *   canonical?: (path: string) => string}} input
 * @returns {string|null}
 */
export function allowReadRefusal({ root, repoRoot = REPO_ROOT, evidenceDir = null,
  workDir = null, home = homedir(), env = process.env, canonical = canonicalPath }) {
  if (typeof root !== 'string' || root.trim() === '') return '--allow-read needs a directory';
  const target = canonical(root);
  if (dirname(target) === target || /^[A-Za-z]:[\\/]?$/u.test(target)) {
    return `--allow-read ${target} is a drive root; a whole drive is never a narrow read root`;
  }
  const repo = canonical(repoRoot);
  if (sameResolvedPath(target, repo) || pathInside(repo, target) || pathInside(target, repo)) {
    return `--allow-read ${target} overlaps this repo ${repo}; the bench's own source is not read material`;
  }
  for (const [label, other] of [['the evidence dir', evidenceDir], ['the work copy', workDir]]) {
    if (typeof other !== 'string' || other.length === 0) continue;
    const forbidden = canonical(other);
    if (sameResolvedPath(target, forbidden) || pathInside(forbidden, target) || pathInside(target, forbidden)) {
      return `--allow-read ${target} overlaps ${label} ${forbidden}; the run writes there`;
    }
  }
  const homePath = canonical(home);
  if (sameResolvedPath(target, homePath) || pathInside(target, homePath)) {
    return `--allow-read ${target} is the home directory or contains it; the home tree holds credentials`;
  }
  for (const path of credentialReadPaths({ home, env })) {
    const store = canonical(path);
    if (sameResolvedPath(target, store) || pathInside(target, store) || pathInside(store, target)) {
      return `--allow-read ${target} overlaps the credential store path ${store}; `
        + 'a credential store is never read material';
    }
  }
  return null;
}

/**
 * The expected deliverable list for this run. An explicit `--deliverables`
 * file wins; otherwise the task text's final explicit path list is used
 * (`taskText`, else `briefText` — a resume passes the follow-up file's text as
 * both); otherwise the default thirteen are the fallback (the old behavior,
 * and the only list an older brief can be measured against). `declared` is
 * false only for that fallback, so a smoke or replay task that names no
 * deliverables gets no `task: the run wrote all N …` row, and a resume round
 * with no list gets a not-applicable row instead of a 0-owed failure.
 * @param {{briefText: string, taskText?: string|null,
 *   deliverablesText?: string|null, sourceLabel?: string|null}} input
 * @returns {{paths: string[], source: string, declared: boolean}}
 */
export function resolveBenchDeliverables({ briefText, taskText = null, deliverablesText = null,
  sourceLabel = null }) {
  if (deliverablesText !== null && deliverablesText !== undefined) {
    const list = parseDeliverables(deliverablesText, sourceLabel ?? '<deliverables>');
    const paths = list.map((deliverable) => deliverable.raw);
    return { paths, source: 'deliverables-file', declared: true,
      duplicates: duplicateDeliverables(paths) };
  }
  const derived = deliverablesFromBrief(taskText ?? briefText, briefText);
  if (derived !== null) {
    // Scan the task text once, never the task plus the whole brief: the brief
    // repeats its list in prose ("this list repeats the one at the end"), which
    // is a second copy by design, not a duplicate in the list the run gates.
    return { paths: derived, source: 'brief', declared: true,
      duplicates: duplicateDeliverablesInText(derived, [taskText ?? briefText]) };
  }
  return { paths: [...DEFAULT_DELIVERABLES], source: 'default', declared: false, duplicates: [] };
}

/**
 * Paths repeated in a resolved list. The explicit-list parser preserves
 * duplicates, so an exact repeat is found here.
 * @param {string[]} paths
 * @returns {string[]}
 */
export function duplicateDeliverables(paths) {
  const seen = new Set();
  const duplicates = new Set();
  for (const path of paths) {
    if (seen.has(path)) duplicates.add(path);
    else seen.add(path);
  }
  return [...duplicates];
}

/** The list-line shape, mirrored from the brief parser: bullet/backtick/punctuation. */
function deliverableListLine(raw) {
  let line = String(raw).trim();
  line = line.replace(/^(?:[-*+]|\d+[.)])\s+/u, '');
  line = line.replace(/^`+/u, '').replace(/`+$/u, '').trim();
  return line.replace(/[.,;:]+$/u, '');
}

/**
 * Paths the text names more than once as a deliverable line. `deliverablesFromBrief`
 * dedupes silently, so the resolved list alone cannot show the repeat; this scan
 * reads the raw lines and counts exact paths (and unique bare names).
 * @param {string[]} paths - the resolved, deduped list.
 * @param {(string|null|undefined)[]} texts
 * @returns {string[]}
 */
export function duplicateDeliverablesInText(paths, texts) {
  const lines = [];
  for (const text of texts) {
    if (text === null || text === undefined) continue;
    for (const raw of String(text).split(/\r?\n/u)) {
      const line = deliverableListLine(raw);
      if (line !== '') lines.push(line);
    }
  }
  const nameCounts = new Map();
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const duplicates = [];
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const count = lines.filter((line) => line === path || (nameCounts.get(name) === 1 && line === name)).length;
    if (count > 1) duplicates.push(path);
  }
  return duplicates;
}

/**
 * The round manifest's `deliverables.count` against the resolved list. The
 * block used to be informational; a brief edited after the manifest was written
 * could gate fewer files than the manifest stated. A manifest without the block
 * is stated as skipped, never silently passed.
 * @param {{manifest: object|null, paths: string[]}} input
 * @returns {{ok: boolean, count?: number, skipped?: string, detail?: string}}
 */
export function manifestDeliverablesGate({ manifest, paths }) {
  const block = manifest?.deliverables;
  if (block === undefined || block === null) {
    return { ok: true, skipped: 'the manifest carries no deliverables block' };
  }
  const count = block.count;
  if (!Number.isSafeInteger(count) || count < 0) {
    return { ok: false,
      detail: `the manifest's deliverables.count is ${JSON.stringify(count)}, not a non-negative integer` };
  }
  if (count !== paths.length) {
    return { ok: false,
      detail: `the manifest's deliverables.count is ${String(count)} but the brief resolves `
        + `${String(paths.length)} deliverable(s); the count and the list must be one fact` };
  }
  return { ok: true, count };
}

/**
 * One row per expected deliverable, in the list's order, k following that
 * order. `exists` is injectable so a test can hold the order without a work
 * copy.
 * @param {string[]} paths
 * @param {string} workDir
 * @param {(path: string) => boolean} [exists]
 * @returns {{k: number, path: string, present: boolean}[]}
 */
export function deliverableRowsFor(paths, workDir, exists = existsSync) {
  return paths.map((path, index) => ({
    k: index + 1,
    path,
    present: exists(join(workDir, path)),
  }));
}

/**
 * The longest CONTIGUOUS prefix of present rows, in list order. `largestReached`
 * is the highest present k even when a lower one is missing; this counts only
 * the `00..k` prefix that exists without a gap, because a checkpoint at k is
 * only meaningful when every earlier checkpoint exists. Rows k=1,2,4 => 2.
 * @param {{k: number, present: boolean}[]} rows
 * @returns {number}
 */
export function contiguousPrefixK(rows) {
  let k = 0;
  let expected = 1;
  for (const row of rows) {
    // A skipped k is as much a gap as an absent file: rows k=1,2,4 stop at 2.
    if (row.k !== expected || !row.present) break;
    k = row.k;
    expected += 1;
  }
  return k;
}

/**
 * The absolute files a checkpoint stop must wait for before firing: every
 * expected deliverable before the target, in the brief's order. The target is
 * checked separately by the watchdog. An empty list means no prefix rule (the
 * target is the first deliverable, or it is not in the derived list at all).
 * @param {{paths: string[], workDir: string, checkpointFile: string}} input
 * @returns {string[]}
 */
export function checkpointPrerequisiteFiles({ paths, workDir, checkpointFile }) {
  if (!Array.isArray(paths) || paths.length === 0 || typeof checkpointFile !== 'string') return [];
  const files = paths.map((path) => resolve(workDir, path));
  const index = files.findIndex((file) => sameResolvedPath(file, checkpointFile));
  if (index <= 0) return [];
  return files.slice(0, index);
}

/**
 * The `task: the run wrote all N …` gate. The label carries the derived count,
 * so a 32-file brief says 32, never 13. A missing deliverable is red and names
 * every missing path; `created`/`expected` are the same numbers the result
 * records.
 * @param {{rows: object[], expected: number, label?: string}} input
 * @returns {{name: string, ok: boolean, expected: number, created: number,
 *   missing: string[], detail: string}}
 */
export function deliverableGate({ rows, expected, label = 'brief' }) {
  const missing = rows.filter((row) => !row.present).map((row) => row.path);
  const created = rows.length - missing.length;
  return {
    name: `task: the run wrote all ${String(expected)} ${label} deliverables `
      + `(${String(created)}/${String(expected)})`,
    ok: missing.length === 0,
    expected,
    created,
    missing,
    detail: missing.length === 0
      ? `${String(created)}/${String(expected)} expected deliverable(s) present in the work copy`
      : `${String(created)}/${String(expected)} expected deliverable(s) present in the work copy; `
        + `missing ${JSON.stringify(missing)}`,
  };
}

/**
 * The `checkpoints` block a result carries. `paths` is the derived list, so a
 * finished-run reader follows the same order and count without a flag.
 * `created`/`filesPresent` count the files present in the work copy;
 * `largestReached` is the highest present k, while `largestCommonK` is the
 * longest contiguous prefix (a missing 02 makes a present 03 not count as k=4).
 * @param {{paths: string[], source: string, rows: object[]}} input
 * @returns {{expected: number, source: string, created: number,
 *   filesPresent: number, largestReached: number, largestCommonK: number,
 *   paths: string[], rows: object[]}}
 */
export function checkpointsBlock({ paths, source, rows }) {
  const created = rows.filter((row) => row.present).length;
  const largestReached = rows.filter((row) => row.present)
    .reduce((max, row) => Math.max(max, row.k), 0);
  return {
    expected: paths.length,
    source,
    created,
    filesPresent: created,
    largestReached,
    largestCommonK: contiguousPrefixK(rows),
    paths: [...paths],
    rows,
  };
}

/** The persisted session log's name, the one `dev/dsh-rig/run.mjs` reads back. */
const SESSION_LOG_FILE = 'session.v4.jsonl';
/** A host that names the log itself (`session-<id>.v4.jsonl`) is read too. */
const SESSION_LOG_ID_PATTERN = /^session-.*\.v4\.jsonl$/u;
const ROUND_DIR_PATTERN = /^round-(\d+)$/u;

/**
 * The follow-up task of a resume round: the file's bytes, verbatim. No brief
 * fence and no trim — the follow-up is a whole task, not a block in the brief.
 * The same text is handed to `resolveBenchDeliverables`, so a final explicit
 * list of names or paths in it is the round's expected list. A file that is
 * empty (or only whitespace) names no task. There is no length cap: the task
 * reaches dsh on stdin, not as one argv element, so the Windows command-line
 * limit no longer applies (the old 60 000-char resume ceiling is gone with the
 * argv channel).
 * @param {string} file
 * @returns {string}
 */
function readTaskFile(file) {
  if (!existsSync(file)) refuse(`bench-run.mjs: --task-file not found at ${file}`);
  const task = readFileSync(file, 'utf8');
  if (task.trim() === '') refuse(`bench-run.mjs: --task-file ${file} names an empty task`);
  return task;
}

/**
 * Every persisted session log under `<evidence>/sessions`, sorted, with the id
 * each log belongs to. This mirrors `dev/dsh-rig/run.mjs`: the id is the
 * DIRECTORY the log sits in (`session-<uuid>`), because that is the value
 * `--session-id` adopts. A host that names the file itself
 * (`session-<id>.v4.jsonl`) is read the same way, with the stem as the id.
 * @param {string} evidenceDir
 * @returns {{file: string, sessionId: string}[]}
 */
export function resumeSessionLogs(evidenceDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      if (entry.name === SESSION_LOG_FILE) out.push({ file: full, sessionId: basename(dir) });
      else if (SESSION_LOG_ID_PATTERN.test(entry.name)) {
        out.push({ file: full, sessionId: entry.name.slice(0, -'.v4.jsonl'.length) });
      }
    }
  };
  walk(join(evidenceDir, 'sessions'));
  return out.sort((left, right) => left.file.localeCompare(right.file));
}

/**
 * The ONE session a resume round continues, plus the boundary it continues
 * from. Zero logs is a resume with nothing to adopt; more than one is a guess
 * between sessions, and either guess (start over or adopt the wrong one)
 * makes the round's record untrue. So both refuse before anything is archived
 * or spawned.
 *
 * `priorSeq` is the last `seq` the session carried before this launch. The new
 * round's BENCH-DONE must be greater than it, so the previous round's marker
 * can never satisfy this one. A malformed line is refused rather than skipped:
 * the boundary would otherwise be a number the log does not support.
 * @param {string} evidenceDir
 * @returns {{ok: true, sessionId: string, file: string, priorSeq: number,
 *   events: number, bytes: number, sha256: string|null}
 *   | {ok: false, detail: string, sessions: object[]}}
 */
export function resumeSessionState(evidenceDir) {
  const sessions = resumeSessionLogs(evidenceDir);
  const root = join(evidenceDir, 'sessions');
  if (sessions.length === 0) {
    return { ok: false, sessions,
      detail: `no persisted session log under ${root}; a resume round needs exactly one` };
  }
  if (sessions.length > 1) {
    return { ok: false, sessions,
      detail: `${String(sessions.length)} persisted session logs under ${root}; `
        + `a resume round needs exactly one: ${sessions.map((session) => session.file).join(', ')}` };
  }
  const snapshot = readJsonLinesSnapshot(sessions[0].file);
  if (snapshot.malformed.length > 0) {
    return { ok: false, sessions,
      detail: `the resumed session log carries ${String(snapshot.malformed.length)} malformed line(s): `
        + snapshot.malformed.slice(0, 10)
          .map((row) => `${basename(sessions[0].file)}:${String(row.line)}`).join(', ') };
  }
  const priorSeq = snapshot.events.reduce((max, event) => {
    const seq = Number(event?.seq);
    return Number.isFinite(seq) && seq > max ? seq : max;
  }, 0);
  return {
    ok: true,
    sessionId: sessions[0].sessionId,
    file: sessions[0].file,
    priorSeq,
    events: snapshot.events.length,
    bytes: snapshot.bytes,
    sha256: snapshot.sha256,
  };
}

/**
 * Archive the previous round's record before this round writes its own.
 *
 * `<evidence>/round-N/` holds the round that already ran: N is the next free
 * archive slot (1 on the first resume, then 2, …) and the new run is round
 * N+1. `result.json` and `stdout.ndjson` are MOVED, never copied, so the
 * evidence dir's top level always describes the latest round and every earlier
 * round keeps its own record. A resume that finds no previous record (a run
 * that died before writing one) creates no empty round dir and keeps its own
 * number.
 * @param {string} evidenceDir
 * @returns {{round: number, archived: {round: number, dir: string, files: string[]}|null,
 *   rounds: {round: number, dir: string, files: string[]}[]}}
 */
export function archiveResumeRound(evidenceDir) {
  let entries = [];
  try { entries = readdirSync(evidenceDir, { withFileTypes: true }); } catch { entries = []; }
  const used = entries
    .filter((entry) => entry.isDirectory() && ROUND_DIR_PATTERN.test(entry.name))
    .map((entry) => Number(ROUND_DIR_PATTERN.exec(entry.name)[1]))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const slot = used.length === 0 ? 1 : Math.max(...used) + 1;
  const files = ['result.json', 'stdout.ndjson'].filter((name) => existsSync(join(evidenceDir, name)));
  if (files.length === 0) return { round: slot, archived: null, rounds: [] };
  const dir = join(evidenceDir, `round-${String(slot)}`);
  mkdirSync(dir, { recursive: true });
  for (const name of files) renameSync(join(evidenceDir, name), join(dir, name));
  const archived = { round: slot, dir, files };
  return { round: slot + 1, archived, rounds: [archived] };
}

/**
 * The resume round's deliverable gate. The expected list was read BEFORE the
 * launch, so a file the previous round wrote is `prior` and can never satisfy
 * this round. The new round must write every path that was missing AND at
 * least one new expected path: a round that writes nothing is red even when
 * every expected file already existed (the later round then owes a NEW list,
 * named by `--deliverables`).
 *
 * A task file that names no explicit deliverable list has nothing to owe or
 * gate: `declared: false` returns a `not-applicable` row that says the default
 * thirteen are recorded but not owed this round. That is not a pass (the row
 * does not contribute to `passed`), and it is not the old red `0 owed` row
 * either.
 * @param {{prior: {rows: object[]}|null, rows: object[], expected: number,
 *   declared?: boolean}} input
 * @returns {{name: string, ok: boolean, class: string, expected: number,
 *   prior: number, owed: number, written: string[], missing: string[],
 *   detail: string}}
 */
export function resumeDeliverableGate({ prior, rows, expected, declared = true }) {
  const priorRows = prior?.rows ?? [];
  const priorPresent = new Set(priorRows.filter((row) => row.present).map((row) => row.path));
  if (!declared) {
    return {
      name: 'task: the resume deliverable gate is not applicable (the task file names no explicit list)',
      ok: true,
      class: 'not-applicable',
      expected,
      prior: priorPresent.size,
      owed: 0,
      written: [],
      missing: [],
      detail: `the task file names no explicit deliverable list; the default ${String(expected)} `
        + 'path(s) are recorded in checkpoints and priorDeliverables but not owed or gated this round',
    };
  }
  const owed = priorRows.filter((row) => !row.present).map((row) => row.path);
  const written = rows.filter((row) => row.present && !priorPresent.has(row.path)).map((row) => row.path);
  const missing = owed.filter((path) => !rows.some((row) => row.path === path && row.present));
  const ok = written.length > 0 && missing.length === 0;
  return {
    name: `task: the resume round wrote the ${String(owed.length)} owed deliverable(s) `
      + `(${String(written.length)}/${String(owed.length)}, ${String(written.length)} new)`,
    ok,
    class: 'measured',
    expected,
    prior: priorPresent.size,
    owed: owed.length,
    written,
    missing,
    detail: ok
      ? `${String(written.length)} new deliverable(s) written this round; `
        + `${String(priorPresent.size)} were already present before it`
      : `${String(written.length)} new deliverable(s) written this round, `
        + `${String(priorPresent.size)} already present before it`
        + `${missing.length === 0 ? '' : `; missing ${JSON.stringify(missing)}`}`
        + `${written.length === 0 ? '; a resume round that writes nothing cannot complete' : ''}`,
  };
}

/**
 * Prune reply rows for a racoons mock-replay script: a queue of identical
 * matchers, each answering a table ask with forgetall for every index. A
 * converted record carries no prune replies, so without these rows the first
 * ask is a loud `no-match`. Rows are prefixed, not appended: the mock picks the
 * FIRST match, and the final-line matcher cannot hold for a record turn, so
 * order is belt-and-braces rather than the guard.
 *
 * Since ADR-0028 the bulk prune is the ONE table asker, so the matcher is the
 * final line and nothing else: no row count, because a 1-row table is the
 * normal tail of a pass. Unused rows are never matched and never asserted on —
 * `replay: consumed prefix N of M scripted replies` counts record rows only.
 * @returns {object[]} `PRUNE_REPLY_CEILING` rows, in script order.
 */
function pruneReplyRows() {
  const match = { last_user_text_matches: PRUNE_MATCH_PATTERN };
  return Array.from({ length: PRUNE_REPLY_CEILING }, (_, index) => ({
    name: `prune-table-forgetall-${String(index + 1).padStart(2, '0')}`,
    match: { ...match },
    reply: { type: 'text', text: PRUNE_REPLY_TEXT, stop_reason: 'end_turn' },
    meta: { replay_prune: true },
  }));
}

/**
 * Append a deterministic filler loop to every scripted shell call, so each
 * tool RESULT the host produces from the replayed record carries at least
 * `minBytes` bytes.
 *
 * The mock scripts assistant turns, not tool results: a result is whatever the
 * host's tool returns when it executes the scripted call. For a record whose
 * calls are shell invocations, the only honest lever is the command text, and
 * the filler is therefore PowerShell that prints N numbered ASCII lines after
 * the recorded output. The loop bound is a function of `minBytes` alone, so two
 * runs with the same flag serve byte-equal commands (and therefore byte-equal
 * results, for a fixed host).
 *
 * Only `type: 'tool_use'` replies with a shell call are touched. Text replies,
 * the prune prefix, the compaction lane and the terminator are untouched.
 * @param {object[]} replies - the record's replies (mutated in place).
 * @param {number} minBytes - the per-result target.
 * @returns {{results: number, perCallBytes: number, lines: number}} what it did.
 */
function inflateToolResults(replies, minBytes) {
  const lines = Math.ceil(minBytes / FILLER_MIN_LINE);
  const filler = `; 1..${String(lines)} | ForEach-Object { '${FILLER_PREFIX}' + $_ + ']' }`;
  let results = 0;
  for (const entry of replies) {
    if (entry?.reply?.type !== 'tool_use') continue;
    for (const call of Array.isArray(entry.reply.calls) ? entry.reply.calls : []) {
      if (!SHELL_TOOLS.has(call.name)) continue;
      const input = call.input !== null && typeof call.input === 'object' ? call.input : null;
      if (input === null || typeof input.command !== 'string') continue;
      // Appended AFTER the recorded command, never replacing it: the record's
      // own output still runs, and the filler is visibly synthetic in the
      // result text a reviewer reads.
      input.command = `${input.command}${filler}`;
      results += 1;
    }
  }
  return { results, perCallBytes: minBytes, lines };
}

/**
 * Read the model-visible context size series out of the mock's request log.
 * `body_bytes` is the exact raw request body the host posted — system prompt,
 * tool schemas and messages — so it is a byte measure of what the model saw,
 * not an estimate derived from the script. Per main request, in request order.
 * @param {object[]} mains - `kind: 'main'` rows from requests.jsonl.
 * @returns {{series: number[], peak: number, peakRequest: number|null, final: number}}
 */
function contextSeries(mains) {
  const series = mains.map((entry) => (Number.isInteger(entry.body_bytes) ? entry.body_bytes : 0));
  let peak = 0;
  let peakRequest = null;
  for (const [index, bytes] of series.entries()) {
    if (bytes > peak) {
      peak = bytes;
      peakRequest = index + 1;
    }
  }
  return { series, peak, peakRequest, final: series.length === 0 ? 0 : series[series.length - 1] };
}

/**
 * The context-series coverage gate (thirteenth audit item 5).
 *
 * The series must describe every conversation turn the session log records. The
 * old row checked only `series.length > 0`, no zero bytes and a peak, so a
 * truncated request log (say, the last half of the conversation) read green.
 * A series SHORTER than the session log's assistant turns is the defect: some
 * reply exists with no request behind it in the artifact. A series longer than
 * the assistant turns is allowed (a request that never produced a reply leaves
 * a row and no assistant message).
 * @param {{series: number[], assistantTurns: number, peakRequest: number|null}} input
 * @returns {{ok: boolean, class: string, detail: string}}
 */
export function contextSeriesCoverage({ series, assistantTurns, peakRequest }) {
  const length = Array.isArray(series) ? series.length : 0;
  if (length === 0) {
    return { ok: false, class: 'failed', detail: 'the context series is empty; no conversation request reached the mock' };
  }
  const zero = series.filter((bytes) => bytes === 0).length;
  if (zero > 0) {
    return { ok: false, class: 'failed', detail: `${String(zero)} of ${String(length)} turn(s) carry 0 bytes` };
  }
  const turns = Number(assistantTurns ?? 0);
  if (Number.isInteger(turns) && turns > length) {
    return { ok: false, class: 'failed',
      detail: `the context series has ${String(length)} turn(s) but the session log carries `
        + `${String(turns)} assistant turn(s); the series is short of the conversation it describes` };
  }
  if (peakRequest === null || peakRequest === undefined) {
    return { ok: false, class: 'failed', detail: 'the series has entries but no peak index' };
  }
  return { ok: true, class: 'measured',
    detail: `${String(length)} turn(s) for ${String(turns)} assistant turn(s); peak at request ${String(peakRequest)}` };
}

/**
 * Host compactions, read from the session log. `compaction-basic` brackets a
 * condensation with `compaction/start` and `compaction/end`; the pruner's
 * `compaction/prune` records are a different plugin and are counted separately,
 * because mixing them would let a tool-result trim masquerade as a compaction.
 *
 * The request index is how many steps had started before the compaction opened
 * (the compaction fires in `agent/pre-step`, so it belongs to the step it
 * precedes): `atRequests` is 1-based over main requests.
 * @param {object[]} sessionEvents
 * @returns {{count: number, atRequests: number[], atSeqs: number[], pruneEvents: number,
 *   prunedResults: number, ends: number}}
 */
export function compactionEvents(sessionEvents) {
  const starts = sessionEvents.filter((event) => event.type === 'compaction/start');
  const ends = sessionEvents.filter((event) => event.type === 'compaction/end');
  const prunes = sessionEvents.filter((event) => event.type === 'compaction/prune');
  const atRequests = starts.map((start) => sessionEvents
    .filter((event) => event.type === 'step/start' && typeof event.seq === 'number' && event.seq < start.seq).length + 1);
  return {
    count: starts.length,
    atRequests,
    atSeqs: starts.map((start) => (typeof start.seq === 'number' ? start.seq : null)),
    pruneEvents: prunes.length,
    prunedResults: prunes.length,
    ends: ends.length,
  };
}

/**
 * The compaction-vs-pressure agreement gate (thirteenth audit items 6 and 7).
 *
 * Three shapes are NOT a measurement and are labelled so a reader cannot count
 * them as a pass:
 *   - zero compactions: `vacuous`, the row had nothing to agree with;
 *   - a `--stop-on-compaction` run whose kill cut the summarization:
 *     `stopped-expected`, the 1-start/0-end pairing is the instrument working;
 *   - a normal run: `measured`.
 * A 1-start/0-end pairing WITHOUT the stop flag is a failed compaction.
 * @param {{compaction: {count: number, ends: number, atRequests: number[]},
 *   context: {series: number[], peak: number}, stoppedOnCompaction?: boolean}} input
 * @returns {{ok: boolean, class: string, detail?: string}}
 */
export function compactionAgreementGate({ compaction, context, stoppedOnCompaction = false }) {
  if (compaction.count === 0) {
    return { ok: true, class: 'vacuous',
      detail: 'no compaction fired; the context series is the only pressure reading this run states' };
  }
  if (compaction.count !== compaction.ends) {
    if (stoppedOnCompaction) {
      return { ok: true, class: 'stopped-expected',
        detail: `stopped on the first compaction: ${String(compaction.count)} compaction/start, `
          + `${String(compaction.ends)} compaction/end — the kill cut the summarization` };
    }
    return { ok: false, class: 'failed',
      detail: `${String(compaction.count)} compaction/start but ${String(compaction.ends)} compaction/end` };
  }
  const first = compaction.atRequests[0];
  if (first === undefined || first <= 1 || first > context.series.length + 1) {
    return { ok: false, class: 'failed',
      detail: `the compaction names request ${String(first)}, outside the `
        + `${String(context.series.length)} turn(s) this run posted` };
  }
  // The checkpoint replaces a span. `series` is indexed by conversation
  // request (1-based), and the slice starts at the request the compaction names,
  // so the compared span is the named request and everything after it — NOT
  // "the request after it". Smallest equal to or larger than the peak means the
  // host "compacted" and kept the pressure, which a vacuous row would hide.
  const after = context.series.slice(first - 1);
  if (after.length === 0) {
    return { ok: false, class: 'failed',
      detail: `no conversation request followed the compaction at request ${String(first)}` };
  }
  const smallest = Math.min(...after);
  return smallest < context.peak
    ? { ok: true, class: 'measured',
      detail: `the context dropped at or after the compaction at request ${String(first)}: peak `
        + `${String(context.peak)} B, smallest at or after ${String(smallest)} B` }
    : { ok: false, class: 'failed',
      detail: `the context never dropped at or after the compaction at request ${String(first)}: `
        + `peak ${String(context.peak)} B, smallest at or after ${String(smallest)} B` };
}

/**
 * The opened/closed pairing (thirteenth audit items 6 and 7). Zero starts is
 * `vacuous`; a stop-caused 1/0 is `stopped-expected`; anything else is
 * `measured` or `failed`. The stop flag never changes the run's exit code.
 * @param {{compaction: {count: number, ends: number}, stoppedOnCompaction?: boolean}} input
 * @returns {{ok: boolean, class: string, detail?: string}}
 */
export function compactionClosedGate({ compaction, stoppedOnCompaction = false }) {
  if (compaction.count === 0) {
    return { ok: true, class: 'vacuous', detail: 'no compaction opened; there is nothing to close' };
  }
  if (compaction.count === compaction.ends) {
    return { ok: true, class: 'measured',
      detail: `${String(compaction.count)} compaction/start and ${String(compaction.ends)} compaction/end` };
  }
  if (stoppedOnCompaction) {
    return { ok: true, class: 'stopped-expected',
      detail: `stopped on the first compaction: ${String(compaction.count)} compaction/start, `
        + `${String(compaction.ends)} compaction/end — the kill prevented the summarization` };
  }
  return { ok: false, class: 'failed',
    detail: `${String(compaction.count)} compaction/start but ${String(compaction.ends)} compaction/end` };
}

/**
 * The host compaction lane: the summarization ask and the post-compaction turn
 * are the host's own requests, so each must be answered by its own row
 * (`compaction-summary-NN` / `replay-post-compaction`), never by a record row.
 * Fourteenth audit item 5: a replay that made no such request has no subject
 * here, so the row is `not-applicable` — a 0-wrong-of-0 pass would be empty.
 * @param {object[]} requests - parsed `requests.jsonl` rows.
 * @returns {{ok: boolean, class: string, detail?: string}}
 */
export function hostCompactionLaneOutcome(requests) {
  const lane = (Array.isArray(requests) ? requests : [])
    .filter((entry) => entry?.kind === 'compaction' || entry?.kind === 'post-compaction');
  if (lane.length === 0) {
    return { ok: true, class: 'not-applicable',
      detail: 'no host compaction request was made, so the lane was not exercised' };
  }
  const wrong = lane.filter((entry) => !/^compaction-summary-\d+$|^replay-post-compaction$/u.test(String(entry.matched)));
  if (wrong.length === 0) {
    return { ok: true, class: 'measured',
      detail: `${String(lane.length)} host-lane request(s) matched their own rows` };
  }
  return { ok: false, class: 'failed',
    detail: `${String(wrong.length)} host-lane request(s) matched a record row, first ${String(wrong[0].matched)}` };
}

/**
 * The context a real provider's session log can state: each assistant turn's
 * billed prompt tokens (input + cacheRead + cacheWrite), which is the context
 * that turn read. There is no request-body byte log on a real route, so this is
 * the only context series the artifact holds. `peakRequest` is the 1-based
 * assistant-turn index, mirroring the byte series' request index.
 * @param {object[]} usageRows - `session-usage.mjs` rows.
 * @returns {{series: number[], peak: number, peakRequest: number|null, final: number}}
 */
export function sessionContextSeries(usageRows) {
  const series = usageRows.map((row) => row.billedTokens);
  let peak = 0;
  let peakRequest = null;
  for (const [index, tokens] of series.entries()) {
    if (tokens > peak) {
      peak = tokens;
      peakRequest = index + 1;
    }
  }
  return { series, peak, peakRequest, final: series.length === 0 ? 0 : series[series.length - 1] };
}

/**
 * The two blocks `result.json` states for EVERY provider (ISSUE-214 item 2).
 *
 * `compaction` is always the session log's own count of `compaction/start` /
 * `compaction/end` rows — never `null`, never a refusal. A run that compacted
 * is a comparison input, not a failed run.
 *
 * `context` picks the measure the artifacts actually hold: the request-body
 * byte series when a request log exists (the mock lanes), otherwise the
 * session log's billed-prompt-token series (the real routes). The old code
 * wrote `null` for both on every non-replay provider, which hid a real
 * compaction the session log carried.
 *
 * @param {object} input
 * @param {object[]} input.sessionEvents
 * @param {object[]} input.requests
 * @param {object[]} input.usageRows
 * @returns {{context: object, compaction: object}}
 */
export function measurementSummary({ sessionEvents, requests, usageRows }) {
  const turns = requests.filter((entry) => entry.kind === 'main' || entry.kind === 'post-compaction');
  const byteSeries = requests.length > 0 ? contextSeries(turns) : null;
  const compaction = compactionEvents(sessionEvents);
  return {
    context: byteSeries === null
      ? {
        unit: 'billed-prompt-tokens',
        source: 'session.v4.jsonl assistant/message data.usage (input + cacheRead + cacheWrite)',
        note: 'the billed prompt each assistant turn read; a real route writes no request-body byte log',
        ...sessionContextSeries(usageRows),
        turns: usageRows.length,
      }
      : {
        unit: 'bytes',
        source: 'requests.jsonl body_bytes, conversation turns only (title/prune/compaction asks excluded)',
        ...byteSeries,
        turns: turns.length,
      },
    compaction: { ...compaction, compacted: compaction.count > 0, triggeredAt: compaction.atRequests },
  };
}

/**
 * One stream entry's block declaration, from both shapes a session log uses.
 *
 * - flat: `{ blockType: "reasoning" }` — the shape the twelfth-audit fixtures
 *   and this file's unit rows use.
 * - nested: `{ type: "chunk", time: …, chunk: { type: "block-start", index: 0,
 *   blockType: "reasoning" } }` — the shape every dsh session log writes. The
 *   2026-11-07 smoke's log carries exactly this under
 *   `scratchpad/launch/2026-11-07-dsh-live/effort-1024/…/session.v4.jsonl`.
 *
 * `block-end` is never a declaration: it closes a block the `block-start`
 * already declared, and it repeats the finished block under `chunk.block`
 * (`{"type":"block-end","index":0,"block":{"type":"reasoning","text":"…"}}`).
 * Nor is the finish entry's `chunk.replayState.blocks[]`, which repeats the
 * content a third time. Returning `null` for both keeps one block one count.
 * @param {object} entry
 * @returns {{blockType: string, index: number|null}|null}
 */
function streamBlockOf(entry) {
  const chunk = entry?.chunk;
  if (chunk !== null && typeof chunk === 'object') {
    if (chunk.type === 'block-end') return null;
    if (typeof chunk.blockType !== 'string') return null;
    return { blockType: chunk.blockType, index: Number.isInteger(chunk.index) ? chunk.index : null };
  }
  if (typeof entry?.blockType !== 'string') return null;
  return { blockType: entry.blockType, index: Number.isInteger(entry?.index) ? entry.index : null };
}

/**
 * ADR-0045's reasoning counts, read STRUCTURALLY from the session rows — never
 * a substring over `JSON.stringify(row)` (which counts each part four times:
 * the content part, the replay-state block, the stream block-start's nested
 * block and the stream entry's nested replayState).
 *
 * - `reasoningParts`: every `type:"reasoning"` CONTENT part, blank included.
 * - `reasoningTurns`: assistant turns carrying at least one NON-BLANK one.
 * - `assistantTurns`: every `assistant/message` row, the population.
 * - `reasoningStreamBlocks`: every stream entry declaring a non-closing
 *   `blockType:"reasoning"` block, from the flat or the nested shape
 *   (`streamBlockOf`); a block declared more than once (a start, then deltas)
 *   counts once per index.
 * - `turnCoverage`: `reasoningTurns / assistantTurns` (0 when the population
 *   is empty, so a run with no assistant turn cannot pass as covered).
 * @param {object[]} rows - parsed session events.
 * @returns {{reasoningParts: number, reasoningTurns: number, assistantTurns: number,
 *   reasoningStreamBlocks: number, turnCoverage: number}}
 */
export function reasoningCountsOf(rows) {
  let reasoningParts = 0;
  let reasoningTurns = 0;
  let assistantTurns = 0;
  let reasoningStreamBlocks = 0;
  for (const row of rows ?? []) {
    const content = Array.isArray(row?.data?.message?.content) ? row.data.message.content
      : Array.isArray(row?.data?.content) ? row.data.content : [];
    const reasoning = content.filter((part) => part?.type === 'reasoning');
    reasoningParts += reasoning.length;
    if (row?.type === 'assistant/message') {
      assistantTurns += 1;
      if (reasoning.some((part) => typeof part.text === 'string' && part.text.trim() !== '')) {
        reasoningTurns += 1;
      }
    }
    // The same block may be declared by a start and again by each delta, so an
    // entry with an index is counted once per row; an index-less flat entry
    // counts on its own.
    const declared = new Set();
    for (const entry of Array.isArray(row?.data?.stream) ? row.data.stream : []) {
      const block = streamBlockOf(entry);
      if (block === null || block.blockType !== 'reasoning') continue;
      if (block.index !== null) {
        if (declared.has(block.index)) continue;
        declared.add(block.index);
      }
      reasoningStreamBlocks += 1;
    }
  }
  const turnCoverage = assistantTurns === 0 ? 0 : reasoningTurns / assistantTurns;
  return { reasoningParts, reasoningTurns, assistantTurns, reasoningStreamBlocks, turnCoverage };
}

/**
 * Which providers state a MEASUREMENT (ADR-0045) rather than a harness proof.
 * `mock` is the smoke proof; `mock-replay` is the offline harness-parity lane
 * (ISSUE-023: a scripted model measures no product quality). Both are excluded
 * from the reasoning claim, which is why their `citableAs` is `none (…)`
 * instead of a measurement label (fourteenth audit item 1).
 * @param {string} provider
 * @returns {boolean}
 */
export function isMeasurementProvider(provider) {
  return provider !== 'mock' && provider !== 'mock-replay';
}

/**
 * ADR-0045's gate over the counts. A measurement run (every provider except the
 * `mock` smoke and the `mock-replay` harness-parity lane) refuses with zero
 * reasoning or with coverage under the declared floor. `--allow-zero-reasoning`
 * is the explicit void flag: the run may proceed, but `citableAs` says
 * `none (no reasoning measured)` and the result records the comparison as void.
 *
 * Since the thirteenth audit (item 1) the citable label is a THREE-source claim:
 * `reasoningParts > 0`, `reasoningStreamBlocks > 0`, and at least one measured
 * main request whose body carries `reasoning_content` (`wire`). A session with
 * content parts but no stream entry is a partial transcript and is not citable;
 * a run whose request bodies were never captured (the real route) records
 * `reasoningWire: "unmeasured"` and may not claim `(reasoning measured)` — it
 * gets the bounded label `measurement (product effect only; reasoning wire
 * unmeasured)`, which says what was and was not read.
 *
 * Fourteenth audit item 1: `mock-replay` is a harness-parity run, so the gate is
 * `not-applicable` and the label is `none (mock replay)` — it can never read as a
 * reasoning measurement.
 *
 * @param {object} input
 * @param {string} input.provider
 * @param {ReturnType<typeof reasoningCountsOf>} input.counts
 * @param {boolean} [input.allowZeroReasoning]
 * @param {{status?: string, requestsWithReasoning?: number}|null} [input.wire]
 *   - as returned by `reasoningWireOf`; omitted means the wire was not read.
 * @returns {{applicable: boolean, ok: boolean, voided: boolean, floor: number,
 *   turnCoverage: number, citableAs: string, detail?: string}}
 */
export function reasoningGate({ provider, counts, allowZeroReasoning = false, wire = null }) {
  const applicable = isMeasurementProvider(provider);
  const floor = REASONING_TURN_COVERAGE_FLOOR;
  const { reasoningTurns, assistantTurns, turnCoverage } = counts;
  const reasoningParts = Number(counts.reasoningParts ?? 0);
  const reasoningStreamBlocks = Number(counts.reasoningStreamBlocks ?? 0);
  const zero = reasoningTurns === 0;
  const belowFloor = !zero && turnCoverage < floor;
  // The two structural sources must agree. Parts with no stream entry (the
  // twelfth-audit fixture's exact shape) is a transcript the host lost half of;
  // it is not evidence that reasoning was measured.
  const missingParts = !zero && reasoningParts === 0;
  const missingStreams = !zero && reasoningStreamBlocks === 0;
  const incomplete = missingParts || missingStreams;
  const wireStatus = typeof wire?.status === 'string' ? wire.status : 'unmeasured';
  const wireReasoning = wireStatus === 'measured' && Number(wire?.requestsWithReasoning ?? 0) > 0;
  const voided = applicable && (zero || belowFloor || incomplete) && allowZeroReasoning;
  const ok = !applicable || (!zero && !belowFloor && !incomplete) || allowZeroReasoning;
  let detail;
  if (!applicable) {
    detail = provider === 'mock-replay'
      ? 'the mock replay is a harness-parity run, not a measurement; the reasoning gate does not apply'
      : 'the mock smoke is a harness proof, not a measurement; the reasoning gate does not apply';
  } else if (zero) {
    detail = `no assistant turn carried a reasoning part (0 of ${String(assistantTurns)}); `
      + 'a measurement run must include the agent\'s reasoning (ADR-0045). '
      + 'Pass --allow-zero-reasoning to record this as a void comparison';
  } else if (belowFloor) {
    detail = `reasoning covers ${String(reasoningTurns)} of ${String(assistantTurns)} assistant turns `
      + `(${String(turnCoverage)}), below the declared floor ${String(floor)}; `
      + 'a partial transcript is not evidence (ADR-0045). '
      + 'Pass --allow-zero-reasoning to record this as a void comparison';
  } else if (incomplete) {
    const missing = [missingParts ? 'content parts' : null, missingStreams ? 'stream blocks' : null]
      .filter((part) => part !== null).join(' and ');
    detail = `reasoning is missing its ${missing}: ${String(reasoningParts)} content part(s) and `
      + `${String(reasoningStreamBlocks)} stream block(s) for ${String(assistantTurns)} assistant turn(s); `
      + 'a session with one source only is a partial transcript and is not citable (ADR-0045). '
      + 'Pass --allow-zero-reasoning to record this as a void comparison';
  } else {
    detail = `${String(reasoningTurns)} of ${String(assistantTurns)} assistant turns carried reasoning `
      + `(coverage ${String(turnCoverage)} >= floor ${String(floor)}), with `
      + `${String(reasoningParts)} content part(s) and ${String(reasoningStreamBlocks)} stream block(s); `
      + (wireReasoning
        ? `the wire carried reasoning_content in ${String(wire.requestsWithReasoning)} main request(s)`
        : wireStatus === 'absent'
          ? 'no measured main request carried reasoning_content'
          : 'the wire was not measured; the claim rests on the session log alone');
  }
  let citableAs;
  if (!applicable) {
    citableAs = provider === 'mock-replay'
      ? 'none (mock replay)'
      : 'none (mock harness proof, not a measurement)';
  } else if (zero || belowFloor) citableAs = 'none (no reasoning measured)';
  else if (incomplete) {
    citableAs = voided ? 'none (no reasoning measured)' : 'none (reasoning transcript incomplete)';
  } else if (wireReasoning) citableAs = 'measurement (reasoning measured)';
  else if (wireStatus === 'absent') citableAs = 'none (no reasoning on the wire)';
  else citableAs = 'measurement (product effect only; reasoning wire unmeasured)';
  return { applicable, ok, voided, floor, turnCoverage, citableAs, detail };
}

/** The wire field the dsh route uses for the agent's own reasoning. */
export const REASONING_WIRE_FIELD = 'reasoning_content';

/**
 * Walk one request body and return the first non-blank assistant reasoning
 * string it carries. The field is the official adapter's `reasoning_content`
 * (opencode-run.mjs names the same field on its route); a body that nests the
 * messages under `messages` is the only shape the host posts.
 * @param {object|null} body - a parsed `requests.jsonl` `body`.
 * @param {string} [field]
 * @returns {string|null}
 */
export function bodyReasoningText(body, field = REASONING_WIRE_FIELD) {
  if (body === null || typeof body !== 'object') return null;
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role !== 'assistant') continue;
    const text = message[field];
    if (typeof text === 'string' && text.trim() !== '') return text;
  }
  return null;
}

/**
 * The wire-level reasoning reading (thirteenth audit item 2).
 *
 * A run with request bodies states whether ANY main request carried the agent's
 * reasoning: `measured` (with the field, the request number and the sha256 of
 * the first string), `absent` (bodies exist, none carries the field — a failed
 * claim, not an empty pass), or `unmeasured` (no body was captured at all, the
 * real route without a capture log). `unmeasured` is NOT a green wire check: it
 * says the session log is the only reasoning source this run read.
 *
 * Only `kind: 'main'` rows are read: title, prune, compaction and
 * post-compaction asks are harness traffic, not a conversation turn.
 * @param {object[]} requests - parsed `requests.jsonl` rows.
 * @param {string} [field]
 * @returns {{status: string, requests: number, bodies: number,
 *   requestsWithReasoning: number, request: number|null, field: string,
 *   sha256: string|null, bytes: number}}
 */
export function reasoningWireOf(requests, field = REASONING_WIRE_FIELD) {
  const rows = Array.isArray(requests) ? requests.filter((entry) => entry?.kind === 'main') : [];
  const withBody = rows.filter((entry) => entry.body !== undefined && entry.body !== null);
  const empty = { requests: rows.length, bodies: withBody.length, requestsWithReasoning: 0,
    request: null, field, sha256: null, bytes: 0 };
  if (withBody.length === 0) return { status: 'unmeasured', ...empty };
  for (const entry of withBody) {
    const text = bodyReasoningText(entry.body, field);
    if (text === null) continue;
    return {
      status: 'measured',
      requests: rows.length,
      bodies: withBody.length,
      requestsWithReasoning: withBody.filter((row) => bodyReasoningText(row.body, field) !== null).length,
      request: typeof entry.n === 'number' ? entry.n : null,
      field,
      sha256: createHash('sha256').update(text).digest('hex'),
      bytes: Buffer.byteLength(text, 'utf8'),
    };
  }
  return { status: 'absent', ...empty };
}

/**
 * The assertion over `reasoningWireOf`. A run with captured bodies must show at
 * least one main request carrying the field; the request body is the only place
 * a wire claim can come from, and the session log alone cannot satisfy it.
 * A run with no captured body is `not-applicable`, never a pass: the result
 * records `reasoningWire: "unmeasured"` and `citableAs` drops the wire claim.
 * The `mock` harness proof and the `mock-replay` harness-parity lane are out of
 * scope, like every other measurement gate: the mock replay emits no reasoning
 * on the wire, so demanding the field there failed every Step 1b/1c run
 * (fourteenth audit item 1).
 * @param {{provider: string, wire: ReturnType<typeof reasoningWireOf>}} input
 * @returns {{applicable: boolean, ok: boolean, class: string, status: string, detail: string}}
 */
export function reasoningWireGate({ provider, wire }) {
  if (provider === 'mock' || provider === 'mock-replay') {
    return { applicable: false, ok: true, class: 'not-applicable', status: 'not-applicable',
      detail: provider === 'mock-replay'
        ? 'mock replay emits no reasoning; the harness-parity run makes no wire reasoning claim'
        : 'the mock smoke is a harness proof; no wire reasoning claim is made' };
  }
  const reading = wire ?? { status: 'unmeasured', requests: 0, bodies: 0, requestsWithReasoning: 0 };
  if (reading.status === 'unmeasured') {
    return { applicable: true, ok: true, class: 'not-applicable', status: 'unmeasured',
      detail: 'no request body was captured, so the reasoning claim rests on the session log alone; '
        + 'reasoningWire is unmeasured, never a wire-level pass' };
  }
  if (reading.status === 'absent') {
    return { applicable: true, ok: false, class: 'failed', status: 'absent',
      detail: `${String(reading.bodies)} main request body(ies) were captured and none carries `
        + `${REASONING_WIRE_FIELD}; the session log states reasoning the wire does not` };
  }
  return { applicable: true, ok: true, class: 'measured', status: 'measured',
    detail: `${String(reading.requestsWithReasoning)} of ${String(reading.bodies)} captured main request `
      + `body(ies) carry ${REASONING_WIRE_FIELD}; first at request ${String(reading.request)}, `
      + `sha256 ${String(reading.sha256)}` };
}

/**
 * Usage coverage: every assistant turn must carry a billable `data.usage` row,
 * and the row count must equal the assistant-turn count. The old real-provider
 * check was `usageRows.length >= 1`, which a single billed step satisfied while
 * later steps were invisible. A missing row means the token watchdog could not
 * see that step's spend, so a `--token-grant` run fails closed (item 4).
 *
 * A row is billable only when at least one prompt-side field is recognizable
 * (`session-usage.mjs` `usageGap`), so a renamed field is a missing row here
 * and not a 0 that reconciles (fourteenth audit item 2). `unrecognizedSeqs`
 * names those separately from the turns with no usage object at all.
 * @param {object[]} sessionEvents
 * @param {object[]} [rows] - as returned by `sessionUsageRows`.
 * @returns {{assistantTurns: number, usageRows: number, missingRows: number,
 *   missingSeqs: (number|null)[], unrecognizedRows: number,
 *   unrecognizedSeqs: (number|null)[], reconciled: boolean}}
 */
export function usageCoverageOf(sessionEvents, rows = sessionUsageRows(sessionEvents)) {
  const assistantTurns = sessionEvents.filter((event) => event?.type === 'assistant/message');
  const missingSeqs = [];
  const unrecognizedSeqs = [];
  for (const event of assistantTurns) {
    const gap = usageGap(event);
    if (gap === null) continue;
    const seq = typeof event.seq === 'number' ? event.seq : null;
    if (gap === 'unrecognized') unrecognizedSeqs.push(seq);
    else missingSeqs.push(seq);
  }
  const missing = missingSeqs.length + unrecognizedSeqs.length;
  return {
    assistantTurns: assistantTurns.length,
    usageRows: rows.length,
    missingRows: missing,
    missingSeqs: [...missingSeqs, ...unrecognizedSeqs],
    unrecognizedRows: unrecognizedSeqs.length,
    unrecognizedSeqs,
    reconciled: missing === 0 && rows.length === assistantTurns.length,
  };
}

/**
 * The `--token-grant` checks, registered only when a grant exists (item 5).
 * Three rows, each a distinct way the ceiling can lie:
 *   - the grant itself (did it fire);
 *   - the grant was READABLE (fifteenth audit item 3): `pollOnce` stores an
 *     unreadable file's or a refused usage row's error in the watchdog state,
 *     and nothing consumed it, so a watchdog that read nothing could pass. A
 *     non-null `error` fails this row by its own name;
 *   - the grant measured every step: a missing usage row, an unrecognized
 *     prompt field, a `compaction/start` with no billable `compaction/summary`
 *     (ISSUE-237), or `observedPromptTokens === 0` while the session log holds
 *     assistant turns is a lower bound/failed read, so the run fails closed.
 * @param {object} input
 * @param {number|null} input.tokenGrant
 * @param {{tokenFired?: boolean, observedPromptTokens?: number|null, polls?: number,
 *   usageUnrecognized?: number, error?: string|null, killLanded?: boolean,
 *   compactionUsageRows?: number, compactionUsageComplete?: boolean}} input.tokenWatch
 * @param {ReturnType<typeof usageCoverageOf>} input.usageCoverage
 * @returns {{name: string, ok: boolean, detail?: string}[]}
 */
export function tokenGrantGates({ tokenGrant, tokenWatch, usageCoverage }) {
  if (tokenGrant === null || tokenGrant === undefined) return [];
  const gates = [{
    name: 'the token grant did not fire',
    ok: tokenWatch?.tokenFired !== true,
    ...(tokenWatch?.tokenFired === true
      ? { detail: tokenWatch.killLanded === false
        ? `the token grant fired at ${String(tokenWatch.trueTotalTokens ?? tokenWatch.observedPromptTokens)} `
          + `true tokens (main-prompt component ${String(tokenWatch.observedPromptTokens)}; grant ${String(tokenGrant)}) `
          + `after ${String(tokenWatch.polls)} poll(s), after the child had already exited; the ceiling was `
          + 'crossed at the final read and nothing needed killing'
        : `the tree was killed at ${String(tokenWatch.trueTotalTokens ?? tokenWatch.observedPromptTokens)} `
          + `true tokens (main-prompt component ${String(tokenWatch.observedPromptTokens)}; grant ${String(tokenGrant)}) `
          + `after ${String(tokenWatch.polls)} poll(s)` }
      : {}),
  }];
  // The poll's own failure, named instead of swallowed. An unreadable session
  // log leaves `observedPromptTokens` at 0, and a 0 the grant compares against
  // never fires: the ceiling did not hold, it was never read.
  {
    const error = tokenWatch?.error ?? null;
    gates.push({
      name: 'the token grant was readable',
      ok: error === null,
      ...(error === null ? {} : { detail: `the watchdog could not read the spend: ${String(error)}` }),
    });
  }
  if (usageCoverage !== undefined) {
    const unrecognized = Number(tokenWatch?.usageUnrecognized ?? 0);
    const observed = Number(tokenWatch?.observedPromptTokens ?? 0);
    // Fail closed on a zero reading when the session log proves steps ran: the
    // grant compared 0, not a spend (fifteenth audit item 3).
    const readNothing = Number(usageCoverage.assistantTurns ?? 0) > 0 && observed === 0;
    // ISSUE-237: a `compaction/start` with no billable `compaction/summary`
    // means the compaction call is missing from the true total. That is the
    // same kind of lower bound a missing usage row is, so it fails closed.
    const compactionIncomplete = tokenWatch?.compactionUsageComplete === false;
    const clean = usageCoverage.reconciled === true && unrecognized === 0 && !readNothing
      && !compactionIncomplete;
    gates.push({
      name: 'the token grant measured every step',
      ok: clean,
      ...(clean
        ? { detail: `${String(usageCoverage.usageRows)} usage row(s) for `
          + `${String(usageCoverage.assistantTurns)} assistant turn(s)` }
        : unrecognized > 0
          ? { detail: `the watchdog read ${String(unrecognized)} usage row(s) with no recognizable `
            + 'prompt token field and refused to sum 0; the grant is a lower bound, so this run fails closed' }
          : readNothing
            ? { detail: `the watch read 0 billed prompt tokens while ${String(usageCoverage.assistantTurns)} assistant `
              + 'turn(s) were recorded; a zero it never read is not a spend, so this run fails closed' }
            : compactionIncomplete
              ? { detail: 'the log started a native compaction but not every one carried a billable '
                + `compaction/summary usage row (${String(Number(tokenWatch?.compactionUsageRows ?? 0))} `
                + 'read); the grant is a lower bound, so this run fails closed' }
              : { detail: `${String(usageCoverage.missingRows)} assistant turn(s) carried no usage row `
                + `(seq ${usageCoverage.missingSeqs.join(', ')}); the grant is a lower bound, so this run fails closed` }),
    });
  }
  return gates;
}

/**
 * The rows that answer the host's compaction lane, in the order the mock tries
 * them. `compaction-basic` asks for a summary as a normal LLM request whose last
 * user message carries its instruction and whose tool list is the conversation's
 * own, so the lane is named by the instruction prefix, not by the absence of
 * tools. A record carries no summary reply, so without these rows the ask is a
 * loud `no-match` and the compaction fails (a failure the session log records,
 * not a compaction). The last row catches the first post-compaction request.
 * @returns {object[]} compaction rows first, the post-compaction row last.
 */
function compactionReplyRows() {
  const rows = [{ name: POST_COMPACTION_NAME,
    match: { body_text_contains: [CHECKPOINT_TAG] },
    reply: { type: 'text', text: POST_COMPACTION_TEXT, stop_reason: 'end_turn' },
    meta: { replay_post_compaction: true } }];
  for (let index = 0; index < COMPACTION_REPLY_CEILING; index += 1) {
    rows.unshift({
      name: `compaction-summary-${String(index + 1).padStart(2, '0')}`,
      match: { body_text_contains: [COMPACTION_ASK_PREFIX] },
      reply: { type: 'text', text: COMPACTION_REPLY_TEXT, stop_reason: 'end_turn' },
      meta: { replay_compaction: true },
    });
  }
  return rows;
}

/**
 * Read the record and its map, convert, rewrite, and append the end marker.
 * Everything here refuses (exit 2) BEFORE the evidence dir is wiped and before
 * any process is spawned: a map that does not bind this record would rewrite
 * paths against the wrong tree, and a mapped target the arm does not hold is
 * the silent failure ISSUE-023 §2 names (a failed tool result still advances
 * `tool_results_count`).
 * @returns {{script: object, record: object, map: object, stats: object}}
 */
function buildReplay(opts) {
  if (!existsSync(opts.record)) refuse(`bench-run.mjs: record not found at ${opts.record}`);
  if (!existsSync(opts.recordMap)) refuse(`bench-run.mjs: record map not found at ${opts.recordMap}`);
  const recordBytes = readFileSync(opts.record);
  const record = {
    file: basename(opts.record),
    sha256: createHash('sha256').update(recordBytes).digest('hex'),
    bytes: recordBytes.length,
  };
  const mapText = readFileSync(opts.recordMap, 'utf8');
  let mapProbe;
  try {
    mapProbe = JSON.parse(mapText);
  } catch (error) {
    refuse(`bench-run.mjs: record map ${opts.recordMap} is not JSON: ${error.message}`);
  }
  // The map states the caps and the text mode it was built for; those ARE the
  // run's, so the two can never drift. loadReplayMap refuses a disagreement.
  const textCap = Number.isInteger(mapProbe?.textCap) ? mapProbe.textCap : REPLAY_TEXT_CAP;
  const maxReplies = Number.isInteger(mapProbe?.maxReplies) ? mapProbe.maxReplies : REPLAY_MAX_REPLIES;
  const textMode = typeof mapProbe?.textMode === 'string' ? mapProbe.textMode : 'placeholder';
  const { doc, sha256: mapSha } = loadReplayMap(mapText, opts.recordMap, {
    sha256: record.sha256, textCap, maxReplies, textMode,
  });

  const { script, stats } = convertTranscript(recordBytes.toString('utf8'), {
    textCap, maxReplies, textMode, sourceName: record.file,
  });
  if (script.replies.length === 0) {
    refuse(`bench-run.mjs: no replayable turn in ${record.file} (blocker ${String(stats.turns.blocker)})`);
  }
  // The map states the shape it was built from; a cap or a record change moves
  // it, and the synthetic keys it maps may no longer be the keys this run emits.
  if (doc.turnCount !== undefined && doc.turnCount !== stats.turns.model_requests) {
    refuse(`bench-run.mjs: map turnCount ${JSON.stringify(doc.turnCount)} != ${stats.turns.model_requests} in the record`);
  }
  if (doc.scriptedTurns !== undefined && doc.scriptedTurns !== stats.turns.mapped) {
    refuse(`bench-run.mjs: map scriptedTurns ${JSON.stringify(doc.scriptedTurns)} != ${stats.turns.mapped} scripted; `
      + 'the cap or the record changed since the map was built');
  }

  const rewritten = rewriteScript(script, doc.pathMap);
  if (rewritten.totals.unmapped > 0) {
    const missing = [...new Set(rewritten.turns.flatMap((turn) => turn.calls)
      .filter((call) => call.path !== null && call.target === null).map((call) => call.path))];
    refuse(`bench-run.mjs: the record names ${missing.length} path(s) the map does not cover: ${missing.join(', ')}; `
      + `add them to ${basename(opts.recordMap)} or the arm will replay failed tool calls`);
  }
  // A mapped target must exist in the arm: a missing file is the same silent
  // failure as an unmapped one. `--dry-work` copies the whole arm, so a target
  // present here is present in the work copy too.
  const targets = [...new Set(rewritten.turns.flatMap((turn) => turn.calls)
    .map((call) => call.target).filter((target) => target !== null))].sort();
  const absent = targets.filter((target) => !existsSync(join(opts.armDir, target)));
  if (absent.length > 0) {
    refuse(`bench-run.mjs: ${absent.length} mapped target(s) absent from ${opts.armDir}: ${absent.join(', ')}; `
      + `fix ${basename(opts.recordMap)} or re-run prep.mjs`);
  }

  // The record is a prefix that simply stops. Without a marker reply the next
  // request is a mock `no-match` (500) and the arm ends on a provider error, not
  // on an answer. The marker matches exactly the state after the last scripted
  // turn, so it can never shadow an earlier one.
  const last = script.replies[script.replies.length - 1];
  const lastCalls = Array.isArray(last.reply.calls) ? last.reply.calls : [];
  const scriptedReplies = script.replies.length;
  let terminator = null;
  if (lastCalls.length > 0) {
    const executed = script.replies
      .reduce((sum, reply) => sum + (Array.isArray(reply.reply.calls) ? reply.reply.calls.length : 0), 0);
    terminator = {
      name: `replay-end-tr${String(executed)}`,
      match: {
        tools_length: 'present',
        tool_results_count: executed,
        last_assistant_tool_names: lastCalls.map((call) => call.name),
      },
      reply: { type: 'text', text: REPLAY_TERMINATOR_TEXT, stop_reason: 'end_turn' },
      meta: { replay_terminator: true },
    };
    script.replies.push(terminator);
  }

  // The perturbation runs last, on the per-run copy only: the terminator's
  // matcher must keep describing the true final state, and the committed map is
  // never touched. A swap that still passes is a vacuous request-key gate.
  if (opts.perturbSwapMatch !== null) {
    if (opts.perturbSwapMatch.some((slot) => slot > scriptedReplies)) {
      refuse(`bench-run.mjs: --perturb-swap-match may only name scripted replies (1..${String(scriptedReplies)}); `
        + 'the terminator is not a scripted turn');
    }
    swapMatchers(script, opts.perturbSwapMatch);
  }

  // Synthetic pressure is applied LAST, after the terminator's matcher is
  // computed from the record's own call counts (inflation changes the command
  // text, never the number of calls), so the terminator still describes the
  // true final key. It runs on this per-run copy only.
  const inflation = opts.inflateBytes === null ? null
    : inflateToolResults(script.replies, opts.inflateBytes);

  const map = {
    file: basename(opts.recordMap),
    sha256: mapSha,
    entries: Object.keys(doc.pathMap).length,
    unused: rewritten.unused,
  };
  // The prune lane (bulk prune's table ask; since ADR-0028 the ONE table lane)
  // belongs to the racoons arm only: the vanilla arm has no mount, so it never
  // asks and must never be served a row it cannot reach. Kept OUT of
  // `script.replies` on purpose — that array is the record's main turns, and
  // the consumed/call-order gates, `--perturb-swap-match` numbering and the
  // terminator's ordinal all count it. The served artifact is composed from the
  // two lists at write time. A run with no `contextWindowTokens` never asks a
  // prune table, so the rows are inert there.
  const pruneRows = opts.arm === 'racoons' ? pruneReplyRows() : [];
  // The compaction lane is served on EVERY mock-replay run, both arms. It used
  // to be gated on `--inflate-bytes`, on the theory that a record could not
  // reach the trigger on its own; a long real record can, and then the host's
  // summarization ask would meet a script with no row for it — a loud
  // `no-match` (500) that ends the arm on a provider error instead of on the
  // host's own compaction. The rows are inert when no compaction fires (their
  // matchers name a request shape no record turn has), so serving them always
  // costs nothing and removes the flag from the compaction mechanism.
  const compactionRows = compactionReplyRows();
  script.meta = {
    ...script.meta,
    // Identity of the seam, carried inside the artifact so two evidence dirs
    // can be compared without reading result.json.
    replay: {
      record: { name: record.file, sha256: record.sha256, bytes: record.bytes },
      map: { name: map.file, sha256: map.sha256 },
      text_cap: textCap,
      max_replies: maxReplies,
      text_mode: textMode,
      scripted_replies: scriptedReplies,
      // Present only when the arm actually carries a prune prefix, so the
      // vanilla script stays byte-identical to a run without this lane.
      ...(pruneRows.length === 0 ? {} : { prune_rows: pruneRows.length }),
      ...(compactionRows.length === 0 ? {} : { compaction_rows: compactionRows.length }),
      terminator: terminator === null ? null : terminator.name,
      ...(inflation === null ? {} : { inflation: {
        minBytes: opts.inflateBytes,
        fillerLines: inflation.lines,
        paddedResults: inflation.results,
      } }),
      blocker: stats.turns.blocker,
      dropped_after_blocker: stats.turns.dropped_after_blocker,
    },
  };
  return {
    script,
    pruneRows,
    compactionRows,
    record,
    map,
    inflation,
    stats: {
      turns: stats.turns,
      toolCalls: stats.tool_calls,
      calls: rewritten.totals,
      turnsDetail: rewritten.turns,
      targets: targets.length,
      scriptedReplies,
      textCap,
      maxReplies,
      textMode,
      terminator: terminator === null ? null : terminator.name,
    },
  };
}

/**
 * The document the mock serves: the record's main turns, with the racoons
 * arm's prune rows and the compaction lane in front. One composition point, so
 * the served artifact, the projection's `script_sha256` and every read-back
 * gate describe the same bytes.
 *
 * Order matters and is the whole contract: the mock takes the FIRST match.
 * Prune rows sit before the compaction rows (their matcher is the table ask's
 * final line, which no main turn carries); then the compaction rows (an
 * instruction-prefix matcher, then the checkpoint-tag row), then the record.
 * The vanilla arm serves the compaction lane too — the host's native compaction
 * is the row being measured there — and carries no prune rows.
 * @param {{script: object, pruneRows: object[], compactionRows: object[]}} replay
 * @returns {object} the served script document.
 */
function servedReplayScript(replay) {
  if (replay.pruneRows.length === 0
    && replay.compactionRows.length === 0) return replay.script;
  return {
    ...replay.script,
    replies: [...replay.pruneRows, ...replay.compactionRows, ...replay.script.replies],
  };
}

/**
 * The rows of a served script that belong to the RECORD, i.e. everything a main
 * request can match. Prune, compaction and post-compaction rows are
 * replay-external: they answer the host's own lanes, carry no record identity,
 * and are queues, so counting them as turns would make "every scripted reply
 * was consumed" demand that unused rows be consumed. This is the bench's
 * counterpart to the rig's `mainRequests`, which filters the prune lane out the
 * same way.
 * @param {object|null} doc - parsed `script.json` (or `replay.script`).
 * @returns {object[]}
 */
function mainReplies(doc) {
  const replies = Array.isArray(doc?.replies) ? doc.replies : [];
  return replies.filter((entry) => entry?.meta?.replay_prune !== true
    && entry?.meta?.replay_compaction !== true
    && entry?.meta?.replay_post_compaction !== true);
}

/**
 * The replay's consumption claim, stated as a PREFIX (ISSUE-214 item 7).
 *
 * The old green line read `every scripted reply was consumed`, which is false on
 * a compaction-cut replay: the host condenses the conversation, the next
 * recorded key no longer exists, and the replay genuinely stops. The claim is
 * "the first N of M record replies ran, in script order", and the detail stays
 * on a green row so a reader sees the prefix even when the run passes.
 *
 * A full replay is the N === M case; a skip, repeat or reorder still fails by
 * request number, and a cut before a single reply is not a replay at all.
 * @param {{wanted: string[], seen: (string|null|undefined)[], cutByCompaction: boolean}} input
 * @returns {{ok: boolean, consumed: number, scripted: number, cutByCompaction: boolean, detail: string}}
 */
export function consumedPrefixOf({ wanted, seen, cutByCompaction }) {
  const scripted = wanted.length;
  const shared = Math.min(wanted.length, seen.length);
  for (let index = 0; index < shared; index += 1) {
    if (seen[index] !== wanted[index]) {
      return {
        ok: false,
        consumed: index,
        scripted,
        cutByCompaction,
        detail: `consumed prefix ${String(index)} of ${String(scripted)} scripted replies; `
          + `request ${String(index + 1)}: expected ${String(wanted[index])}, matched ${String(seen[index])}`,
      };
    }
  }
  const consumed = seen.length;
  if (seen.length === wanted.length) {
    return {
      ok: true,
      consumed,
      scripted,
      cutByCompaction,
      detail: `consumed prefix ${String(consumed)} of ${String(scripted)} scripted replies`
        + `${cutByCompaction ? '; all record replies ran before the host compaction' : '; no compaction cut'}`,
    };
  }
  if (seen.length > wanted.length) {
    return {
      ok: false,
      consumed,
      scripted,
      cutByCompaction,
      detail: `expected ${String(wanted.length)} main request(s) (${String(wanted.length - 1)} scripted `
        + `+ 1 end marker), saw ${String(seen.length)}`,
    };
  }
  if (cutByCompaction) {
    return seen.length > 0
      ? {
        ok: true,
        consumed,
        scripted,
        cutByCompaction: true,
        detail: `consumed prefix ${String(consumed)} of ${String(scripted)} scripted replies; `
          + 'cut by host compaction, so the record cannot continue past it',
      }
      : {
        ok: false,
        consumed: 0,
        scripted,
        cutByCompaction: true,
        detail: 'the host compacted before a single record reply was served',
      };
  }
  return {
    ok: false,
    consumed,
    scripted,
    cutByCompaction: false,
    detail: `expected ${String(wanted.length)} main request(s) (${String(wanted.length - 1)} scripted `
      + `+ 1 end marker), saw ${String(seen.length)}`,
  };
}

/** Resolve the installed dsh `lib/bin.js`; the PID must be the real process. */
function resolveDshBin(override) {
  if (override !== null) {
    const absolute = resolve(override);
    if (!existsSync(absolute)) refuse(`bench-run.mjs: --dsh-bin not found at ${absolute}`);
    return absolute;
  }
  // The discovery helpers are child processes too, so they get the same
  // allow-listed env as every other non-dsh child (ISSUE-260/270). A caller's
  // credential names never ride into `npm root` or `where`.
  const candidates = [];
  const npmRoot = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'],
    { encoding: 'utf8', windowsHide: true, env: childEnvBase() });
  if (npmRoot.status === 0 && typeof npmRoot.stdout === 'string') candidates.push(join(npmRoot.stdout.trim(), ...DSH_PACKAGE));
  const where = spawnSync('where', ['dsh'], { encoding: 'utf8', windowsHide: true, env: childEnvBase() });
  if (where.status === 0 && typeof where.stdout === 'string') {
    const first = where.stdout.split(/\r?\n/u).find((line) => line.trim() !== '');
    if (first !== undefined) {
      const shimDir = dirname(first.trim());
      candidates.push(join(shimDir, 'node_modules', ...DSH_PACKAGE));
      candidates.push(join(shimDir, '..', 'node_modules', ...DSH_PACKAGE));
    }
  }
  for (const candidate of candidates) if (existsSync(candidate)) return resolve(candidate);
  refuse('bench-run.mjs: cannot locate dsh; pass --dsh-bin <path-to-bin.js>');
}

/**
 * Base rows. Mock mirrors the rig's throwaway home; a real provider
 * (`deepseek-official`, `deepseek-v4-pro`) is the tier-3 overlay:
 * credentials re-enabled against the env-supplied store path, the default model
 * moved to that route, and both writable roots redirected into the evidence dir
 * so the real `~/.dsh` session store is never touched.
 * @param {'mock'|'mock-replay'|'deepseek-official'|'deepseek-v4-pro'} provider
 * @param {number|null} hostWindowTokens - the host's native compaction window
 *   (`--host-window-tokens`); the default applies when absent.
 * @returns {string[]}
 */
function baseRows(provider, hostWindowTokens) {
  if (MOCK_PROVIDERS.has(provider)) {
    return [
      '- id: session-persistence-jsonl',
      '  config:',
      "    root: !!js dshHomePath('sessions')",
      '    compression: none',
    ];
  }
  const route = REAL_ROUTES[provider];
  return [
    '- id: credentials',
    '  disabled: false',
    // A path, never key material; dsh resolves the value from the store.
    '  config:',
    '    path: !!js process.env.RIG_CREDENTIALS_PATH',
    '- id: session-title-llm',
    '  disabled: true',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${route.provider}`,
    `    model: ${route.model}`,
    // Without an effort pi-ai sends `thinking: {type: "disabled"}` on the
    // DeepSeek provider, so the live run records zero reasoning. `low` is in
    // the map below and on the official catalog's effort list.
    '    reasoningEffort: low',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${route.provider}:`,
    `        displayName: ${route.provider}`,
    `        apiKeyEnv: ${route.apiKeyEnv}`,
    '        api: openai-completions',
    `        baseURL: ${route.baseURL}`,
    '        models:',
    `          - id: ${route.model}`,
    `            name: ${route.model}`,
    '            input:',
    '              - text',
    `            contextWindow: ${String(hostWindowTokens ?? HOST_WINDOW_TOKENS)}`,
    '            reasoningEfforts:',
    '              off: null',
    '              low: low',
    '              medium: medium',
    '              max: max',
    '- id: session-persistence-jsonl',
    '  config:',
    '    root: !!js process.env.RIG_SESSIONS_DIR',
    '    compression: none',
    '- id: storage-json',
    '  config:',
    '    root: !!js process.env.RIG_STORAGES_DIR',
  ];
}

/**
 * The mount's config: the cap pair, the half-window trigger when the run names
 * one, and (for the rig wrapper) the harness paths it owns. One function so the
 * patch row and `result.json` can never state different configs.
 *
 * `--window-tokens` is the delay-ratio instrument: the mount's own trigger fires
 * at half this value on its transcript-only estimate. The real route defaults to
 * the host's native 400 000 (owner clarification 2026-10-24), so the prune bar is
 * 200 000 and the native backstop is 400 000; the mock lanes leave it unset
 * (`null`, the shipped default) unless a run names it, because their thresholds
 * belong to the fixtures. A bench run that names it is measuring the mechanism at
 * a chosen threshold, not shipping a default.
 *
 * `--prune-threshold-tokens` is ADR-0050's absolute bar: a positive token count
 * the product owns, independent of the host window, written only when a run names
 * one. Absent leaves the key out, so the deprecated half-window rule above (if the
 * run named a window) is what remains in force; the launcher never invents a bar.
 *
 * `--judge-timeout-ms` is the bulk prune's ask deadline, and it is spread the
 * same way: absent means the key is absent, so the mount's own default (120 s
 * since ISSUE-126, `DEFAULT_ASK_TIMEOUT_MS` in `llm-ask.ts`) applies and a run
 * only raises it. At ~200 k billed tokens prefill alone costs ~16.5 s, which the
 * former 30 s bound left ~13.5 s for the twelve structured rows, so the ask
 * timed out; that is why the shipped default is 120 s.
 *
 * `--dedupe-superseded-by-reread` and `--dedupe-call-echo` are switches, not
 * numbers, and they follow the same absence rule: each class ships off (ADR-0037
 * decision 6), so a key is written only when its flag was given. Writing `false`
 * would be the same measurement and a worse artifact — a reader could not tell
 * an omitted flag from a deliberate off — and the entry's own default is already
 * `false`.
 * @param {object} opts - parsed CLI options.
 * @param {{evidenceDir: string, storageRoot: string}|null} harness
 * @returns {object}
 */
export function mountConfig(opts, harness) {
  const config = {
    ...CAP_CONFIG,
    ...(opts.windowTokens === null ? {} : { contextWindowTokens: opts.windowTokens }),
    ...(opts.pruneThresholdTokens === null ? {} : { pruneThresholdTokens: opts.pruneThresholdTokens }),
    ...(opts.entryAskBatchSize === null ? {} : { entryAskBatchSize: opts.entryAskBatchSize }),
    ...(opts.entryAskTrigger === null ? {} : { entryAskTrigger: opts.entryAskTrigger }),
    // Owner ruling 2026-11-05: `jsonl-20` is the shipped answer format, and the
    // row states it even when the flag is omitted, so a launch record always
    // names the grammar its asks were measured under.
    entryAskGrammar: opts.entryAskGrammar ?? 'jsonl-20',
    // ISSUE-221; ADR-0056: the bulk ask's grammar. The row always states it, so
    // a launch record names the contract its prune asks were measured under.
    pruneAskGrammar: opts.pruneAskGrammar ?? 'nokeepall',
    ...(opts.dedupeSupersededByReread ? { dedupeSupersededByReread: true } : {}),
    ...(opts.dedupeCallEcho ? { dedupeCallEcho: true } : {}),
    ...(opts.judgeTimeoutMs === null ? {} : { judgeTimeoutMs: opts.judgeTimeoutMs }),
  };
  return harness === null ? config
    : { ...config, evidenceDir: harness.evidenceDir, crematorStorageRoot: harness.storageRoot };
}

/**
 * What the mount row's constants MEAN in `result.json` (ISSUE-214 item 6).
 * `capBytes` and `capHeadBytes` are accepted-and-ignored historical keys
 * (ADR-0014 decision 1, restated product-wide by ADR-0048), so the record says
 * `capIgnored: true` instead of letting a reader believe the bench turned a cap
 * mechanism on. `sealMaxLatencyTurns` is the live bound beside them.
 *
 * Fourteenth audit item 6: `capIgnored` is a CONSTANT — no probe of the mounted
 * build produced it — so `capIgnoredSource: "declared"` rides beside it. A
 * reading and a declaration must not look alike in the artifact.
 *
 * ADR-0050 names the removal shape in the record: `pruneThresholdTokens` is the
 * absolute bar the run named (null when it named none), and `entryAskMode` is the
 * entry trigger's mode — `off` when the per-result ask is off, which is also the
 * absent default the mount resolves; `landed-bytes` when a byte trigger was
 * written; `count` only when the run explicitly selected the compatibility
 * cadence. The config row still carries the full objects; these two keys let a
 * reader name the shape without parsing them.
 * @param {object} config - the parsed mount config row.
 * @returns {{capIgnored: true, capIgnoredSource: string, inertKeys: string[],
 *   inertValuesMatch: boolean, liveKeys: string[], sealBoundMatches: boolean,
 *   pruneThresholdTokens: number|null, entryAskMode: string}}
 */
export function mountConfigFacts(config) {
  const inertKeys = Object.keys(INERT_CAP_KEYS);
  return {
    capIgnored: true,
    // Not a reading: ADR-0014/ADR-0048 declare the keys inert. Naming the
    // source lets a reader tell this constant from a probe of the build.
    capIgnoredSource: 'declared',
    inertKeys,
    inertValuesMatch: inertKeys.every((key) => config?.[key] === INERT_CAP_KEYS[key]),
    liveKeys: ['sealMaxLatencyTurns'],
    sealBoundMatches: config?.sealMaxLatencyTurns === LIVE_SEAL_BOUND,
    // ADR-0050: the shape, named. `null` is "no bar named", never a bar of zero.
    pruneThresholdTokens: config?.pruneThresholdTokens ?? null,
    // Absent means the mount's `off` default (ADR-0050 decision 4), so the
    // record states `off` rather than an empty value a reader could misread.
    entryAskMode: config?.entryAskTrigger?.mode ?? 'off',
  };
}

/**
 * The mount row: the entry by file URL, config as one-line JSON.
 *
 * The wrapper strips the harness keys before calling the shipped entry, and the
 * shipped entry would drop unknown keys anyway; they are written here so the
 * artifact states where the evidence and the per-session ledger went.
 */
function mountRows(entryUrl, opts, harness) {
  return [
    '- insert:',
    '    - id: racoons-mount',
    `      name: '${entryUrl.replace(/'/gu, "''")}'`,
    `      config: ${JSON.stringify(mountConfig(opts, harness))}`,
  ];
}

/**
 * Write `patch.yml`: base rows, then the mount (racoons only), then the deny
 * rows last. One file, so the recorded launch command names exactly one layer
 * and the composition order is readable in the artifact.
 * @returns {string} the path
 */
export function writePatch(evidenceDir, opts, entryUrl, harness) {
  const rows = [...baseRows(opts.provider, opts.hostWindowTokens ?? null)];
  // ISSUE-297: the live shell boundary. A configured pwsh guard is named on
  // the composed executor row, so every pwsh call in BOTH arms runs through
  // the wrapper. The wrapper refuses a command that names a path outside the
  // workspace and returns a normal tool error; the run continues.
  if (opts.pwshGuard) {
    rows.push('- id: pwsh-sandbox', '  config:',
      `    pwshPath: '${String(opts.pwshGuard).replace(/'/gu, "''")}'`);
  }
  if (entryUrl !== null) rows.push(...mountRows(entryUrl, opts, harness));
  // Owner ruling 2026-11-09: the row is ARM-DEPENDENT, not run-wide. The
  // racoons arm writes the ADR-0041 disable row, because the mount must be the
  // only remover; the vanilla arm writes NO row, so the host pruner keeps its
  // shipped default (on) and the composed row is left untouched.
  // `--allow-host-pruner` (and its older spelling `--end-pressure-isolation`)
  // is still the racoons arm's deliberate opt-out; on vanilla it is redundant.
  if (hostPrunerState(opts.arm, opts.allowHostPruner) === HOST_PRUNER_DISABLED) {
    rows.push(...HOST_PRUNER_ROW);
  }
  // Bench law: no official DeepSeek endpoint unless the run named it. The rows
  // are written by default, so a forgotten flag leaves every official route
  // disabled; `--allow-official-spend` skips them only when the provider itself
  // reaches `api.deepseek.com` (owner ruling 2026-11-05). They sit before the
  // deny rows and after every base row, so nothing earlier in the file can
  // re-open them (later rows win per row id).
  const official = officialRouteFor(opts.provider);
  const officialAllowed = official !== null && opts.allowOfficialSpend;
  if (!officialAllowed) rows.push(...OFFICIAL_ROUTE_ROWS);
  // `llm-deepseek` IS the mock lanes' transport — the loopback mock speaks
  // through it via `DEEPSEEK_BASE_URL` — so it is removed only on a real route,
  // where `llm-pi-ai` serves the bench route and this provider is unused. An
  // authorized official route keeps it, because the flag authorizes the host,
  // not one row.
  if (!MOCK_PROVIDERS.has(opts.provider) && !officialAllowed) rows.push(...OFFICIAL_LLM_ROW);
  // `--deny-web` re-closes the four web rows when the official opt-in skipped
  // the row set above. It is written AFTER every row that could have opened
  // them (later rows win per row id) and BEFORE the deny rows, so a run that
  // names it cannot offer `web_search`/`web_fetch` whatever the route chose.
  // On every other route the default row set already carries the four disable
  // rows, so writing them again would only duplicate the decision.
  if (opts.denyWeb && officialAllowed) rows.push(...WEB_DENY_ROWS);
  // `--omit-deny-rows` is the perturbation that proves the probe can fail
  // (subagent-deny.md §"Perturbation"). It is never a bench configuration.
  if (!opts.omitDenyRows) rows.push(...DENY_ROWS);
  // Written last so no row pushed above can hide a second pruner row. A patch
  // that carried one disable row and one enable row would be two decisions.
  const prunerRows = hostPrunerRowCount(rows);
  if (prunerRows > 1) {
    throw new Error(`bench-run.mjs: the composed patch carries ${String(prunerRows)} ${HOST_PRUNER_ID} rows; `
      + 'ADR-0041 allows one decision and a disable row beside an enable row is two');
  }
  const path = join(evidenceDir, 'patch.yml');
  writeFileSync(path, `${rows.join('\n')}\n`);
  return path;
}

/**
 * The launcher's own invocation (ISSUE-091): the flags this run was started
 * with, verbatim, written beside `task.txt` before the bench child starts.
 * `result.json.dsh.launchCommand` is the CHILD's command line, so without this
 * record a DoD box that requires a flag "recorded verbatim" could only be
 * inferred from `patch.yml`. argv only: never the environment, never a key.
 *
 * An official provider opened by `--allow-official-spend` also gets an
 * `officialRoute` block here, before the bench child starts: the evidence names
 * the route and the owner authorization even if the run later fails. The block
 * is absent on every other run, so a record without it states "no official
 * spend was authorized" unambiguously.
 *
 * Since ADR-0041 every launch also carries a `hostPruner` block. It is the
 * INTENT written before the child starts: the arm's expected state (the racoons
 * arm disables the host pruner; the vanilla arm leaves it at the host default)
 * and, for the racoons opt-out, by which flag. The outcome — the composed
 * config and the session log's `compaction/prune` count — is `result.json`'s own
 * `hostPruner` block.
 * @param {string} evidenceDir - the run's evidence dir.
 * @param {string[]} argv - `process.argv.slice(2)`, unjoined.
 * @param {object} opts - parsed CLI options (provider, the opt-ins, the pruner).
 * @returns {string} the path
 */
function writeLaunchRecord(evidenceDir, argv, opts) {
  const official = opts.allowOfficialSpend ? officialRouteFor(opts.provider) : null;
  const stopPolicy = opts.stopAtCheckpoint === null && opts.stopAfterCompactions === null
    ? null
    : {
      checkpoint: opts.stopAtCheckpoint ?? null,
      afterCompactions: opts.stopAfterCompactions ?? null,
      censoredPartial: true,
      note: 'a stop ends the run before BENCH-DONE; the result is a censored partial, never a pass',
    };
  const path = join(evidenceDir, 'launch.json');
  const prunerState = hostPrunerState(opts.arm, opts.allowHostPruner);
  // The opt-out flag exists only when it actually changed the arm's default: on
  // the vanilla arm the state is already `host-default`, so the flag is
  // redundant and must not be recorded as a decision this run took. The value
  // is the flag spelling, the shape ADR-0041 recorded; `state` carries the word.
  const prunerOptOut = opts.allowHostPruner && opts.arm === 'racoons'
    ? (opts.endPressureIsolation ? '--end-pressure-isolation' : '--allow-host-pruner')
    : null;
  const workspaceTemp = workspaceTempSetup({
    // The child's cwd is the arm, or the `--dry-work` copy under the evidence
    // dir; both are world roots, so the record names the same path the spawn
    // will use.
    workDir: opts.dryWork ? join(evidenceDir, 'work') : opts.armDir,
    workspaceOnly: opts.workspaceOnly,
  });
  writeFileSync(path, `${JSON.stringify({
    schema: 'racoons-bench-launch/1',
    script: fileURLToPath(import.meta.url),
    cwd: process.cwd(),
    argv,
    // Optional by owner ruling: 0 means no wall-clock box; the token grant is
    // the only cap. A positive value arms one. The number is recorded either way.
    killMs: opts.killMs,
    // ISSUE-291: the host's native compaction window composed onto the
    // llm-pi-ai model row, recorded before the child starts. Absent on the mock
    // lanes, which have no host window.
    ...(opts.hostWindowTokens === null || opts.hostWindowTokens === undefined
      ? {}
      : { hostWindow: { contextWindow: opts.hostWindowTokens, flag: '--host-window-tokens' } }),
    hostPruner: {
      row: HOST_PRUNER_ID,
      arm: opts.arm,
      state: prunerState,
      disabled: prunerState === HOST_PRUNER_DISABLED,
      optOut: prunerOptOut,
      note: prunerState === HOST_PRUNER_DISABLED
        ? 'the host tool-result pruner is disabled in this arm; a compaction/prune event fails the run'
        : prunerOptOut === null
          ? 'the vanilla arm leaves the host tool-result pruner at its shipped default (on) and writes no row for it'
          : 'the host tool-result pruner was left mounted on purpose; this run is not a product measurement',
    },
    ...(official === null ? {} : { officialRoute: officialAuthorizationRecord(official) }),
    // The run's read and web intent, written before the child starts so the
    // artifact states what was asked even when the run later fails. `--deny-web`
    // is the explicit re-close of the four web rows; `--workspace-only` is the
    // strict read rule (any path outside the arm world fails the run).
    ...(opts.denyWeb ? { webTools: { denied: true, deniedBy: '--deny-web', rows: WEB_ROUTE_IDS } } : {}),
    ...(workspaceTemp === null
      ? {}
      : { readBoundary: { workspaceOnly: true, allowRead: [],
        allowToolRoots: opts.allowToolRoots,
        tempDir: workspaceTemp.dir,
        tempEnv: workspaceTemp.env,
        note: 'a tool call naming a path outside the arm world fails the run (exit 4); '
          + 'the child\'s TEMP, TMP and TMPDIR name tempDir, inside the arm (or its --dry-work copy)' } }),
    ...(stopPolicy === null ? {} : { stopPolicy }),
  }, null, 2)}\n`);
  return path;
}

function sha256File(full) {
  return createHash('sha256').update(readFileSync(full)).digest('hex');
}

/**
 * The dist tree's identity for `result.json.mount.distSha256`, or `null` when
 * the tree is absent. `null` is the honest value: it says no dist was identified,
 * never that the dist matched. A mounted racoons arm always has one — the launcher
 * refuses to start when the entry is missing — so `null` is reachable only on the
 * vanilla arm's absent mount (which carries no `distSha256` key at all) or a
 * hand-supplied dist that does not exist yet.
 * @param {string} dir - the dist root the launcher resolved.
 * @returns {string|null}
 */
function distTreeSha256OrNull(dir) {
  try {
    return distTreeSha256(dir).sha256;
  } catch {
    return null;
  }
}

function toPosix(root, full) {
  return full.slice(root.length + 1).split(sep).join('/');
}

/** The arm's identity multiset digest, same construction as prep.mjs. */
function digestTree(root) {
  const lines = [];
  const walk = (dir, top) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        walk(full, false);
        continue;
      }
      if (!entry.isFile()) continue;
      if (top && NOT_COPIED.has(entry.name)) continue;
      lines.push(`${sha256File(full)}  ${toPosix(root, full)}`);
    }
  };
  walk(root, true);
  lines.sort();
  return { files: lines.length, digest: createHash('sha256').update(lines.join('\n')).digest('hex') };
}

/** Copy one arm into a scratch work dir. The source is never written. */
function copyTree(from, to) {
  let copied = 0;
  const walk = (srcDir, destDir, top) => {
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const src = join(srcDir, entry.name);
      const dest = join(destDir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        walk(src, dest, false);
        continue;
      }
      if (!entry.isFile()) continue;
      if (top && NOT_COPIED.has(entry.name)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(src));
      copied += 1;
    }
  };
  walk(from, to, true);
  return copied;
}

/**
 * Read one JSONL artifact ONCE and hash the exact bytes that were parsed.
 *
 * A second read is a different file: the child (session log) or the mock
 * (requests.jsonl) may still be appending, and a hash taken from a later read
 * would describe bytes no parser ever saw. The audit (ISSUE-214 item 10) asked
 * for one read, so the snapshot carries `bytes`, `sha256` and the parsed rows
 * from the same buffer.
 *
 * A malformed line is kept as `{type:'unparsed'}` for continuity, and is ALSO
 * named in `malformed` with its 1-based line number. Callers gate on that list
 * (`jsonLineGate`); the audit found the old reader only pushed a placeholder
 * and never rejected anything (ISSUE-214 item 3).
 *
 * `readBytes` is injectable so a test can prove the helper reads once even when
 * the underlying file would change under a second call.
 *
 * @param {string} file - path to read.
 * @param {(path: string) => Buffer|string} [readBytes] - one-read source.
 * @returns {{file: string, present: boolean, bytes: number, sha256: string|null,
 *   events: object[], malformed: {line: number, text: string}[]}}
 */
export function readJsonLinesSnapshot(file, readBytes = (path) => readFileSync(path)) {
  let raw;
  try {
    raw = readBytes(file);
  } catch {
    return { file, present: false, bytes: 0, sha256: null, events: [], malformed: [] };
  }
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const text = buffer.toString('utf8');
  const events = [];
  const malformed = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      events.push({ type: 'unparsed', line, lineNumber: index + 1 });
      malformed.push({ line: index + 1, text: line.slice(0, 160) });
    }
  }
  return {
    file,
    present: true,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    events,
    malformed,
  };
}

/**
 * The malformed-line gate over one or more snapshots. Fails by name with the
 * file's 1-based line numbers, as the audit asked: a corrupt session log must
 * not read as a shorter clean one.
 *
 * Fourteenth audit item 5: an ABSENT log (no snapshot present) is
 * `not-applicable` — the live route writes no `requests.jsonl`, and "every line
 * parses" over a file that does not exist is not a reading. A present file with
 * zero bytes is `vacuous`: the artifact exists, its population is empty.
 * @param {object[]} snapshots - as returned by `readJsonLinesSnapshot`.
 * @param {string} label - the artifact's name in the detail (`session log`, …).
 * @returns {{ok: boolean, count: number, class: string, detail?: string}}
 */
export function jsonLineGate(snapshots, label = 'log') {
  const bad = [];
  const present = snapshots.filter((snapshot) => snapshot.present === true);
  for (const snapshot of snapshots) {
    for (const row of snapshot.malformed ?? []) {
      bad.push({ file: snapshot.file, line: row.line });
    }
  }
  if (bad.length === 0) {
    if (present.length === 0) {
      return { ok: true, count: 0, class: 'not-applicable',
        detail: `no ${label} existed, so there was no line to parse` };
    }
    if (present.every((snapshot) => snapshot.bytes === 0)) {
      return { ok: true, count: 0, class: 'vacuous',
        detail: `the ${label} is empty; there was no line to parse` };
    }
    return { ok: true, count: 0, class: 'measured' };
  }
  const named = bad.slice(0, 10).map((row) => `${basename(row.file)}:${String(row.line)}`).join(', ');
  return {
    ok: false,
    count: bad.length,
    class: 'failed',
    detail: `${String(bad.length)} malformed ${label} line(s): ${named}`
      + `${bad.length > 10 ? `, and ${String(bad.length - 10)} more` : ''}`,
  };
}

/** Text of one session event's content blocks. */
function textOfEvent(event) {
  const blocks = event?.data?.message?.content ?? event?.data?.content ?? [];
  return Array.isArray(blocks)
    ? blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('')
    : '';
}

function resultOf(callId) {
  return (event) => {
    const message = event?.data?.message ?? {};
    const source = message.source ?? {};
    const id = source.callId ?? message.toolCallId;
    return event.type === 'tool/result' && id === callId;
  };
}

/**
 * The deny probe (subagent-deny.md): leg A reads what the model was offered,
 * leg B reads what happened to the summon. Both are evaluated from the session
 * log, never from the answer's wording.
 * @returns {{legA: object, legB: object, verdict: 'pass'|'partial'|'fail', doc: string}}
 */
function denyProbe(sessionEvents, arm) {
  const header = sessionEvents.find((event) => event.type === 'request/header');
  const tools = header?.data?.header?.tools;
  const names = Array.isArray(tools) ? tools.map((tool) => String(tool.name)) : [];
  const present = DENIED_TOOL_NAMES.filter((name) => names.includes(name));
  const legA = { headerTools: names.length, toolNames: names, deniedPresent: present, verdict: header === undefined ? 'fail' : present.length === 0 ? 'pass' : 'fail' };

  const call = sessionEvents.find((event) => event.type === 'tool/call' && event.data?.name === 'subagent');
  const callId = call === undefined ? null : String(call.data?.callId ?? '');
  const result = callId === null ? undefined : sessionEvents.find(resultOf(callId));
  const message = result?.data?.message ?? {};
  const resultText = textOfEvent(result);
  const error = result?.data?.error ?? message.error ?? null;
  const code = typeof error?.code === 'string' ? error.code
    : typeof error?.info?.code === 'string' ? error.info.code : null;
  const errorName = typeof error?.name === 'string' ? error.name
    : typeof error?.info?.name === 'string' ? error.info.name : null;
  const descriptorEvents = sessionEvents.filter((event) => event.type === 'subagent/descriptor' || event.type === 'subagent/catalog').length;
  const wanted = 'Error: unknown tool "subagent"';
  const ok = call !== undefined
    && message.isError === true
    && code === 'UNKNOWN_TOOL'
    && errorName === 'ToolNotFoundError'
    && resultText.startsWith(wanted)
    && descriptorEvents === 0;
  const legB = {
    toolCall: call === undefined ? 'absent' : 'present',
    resultError: message.isError === true ? 'yes' : 'no',
    name: errorName,
    code,
    text: resultText.slice(0, 80),
    descriptorEvents,
    verdict: ok ? 'pass' : call === undefined ? 'partial' : 'fail',
  };
  const verdict = legA.verdict === 'pass' && legB.verdict === 'pass' ? 'pass'
    : legA.verdict === 'pass' && legB.verdict === 'partial' ? 'partial' : 'fail';
  const reason = verdict === 'pass'
    ? 'the header omits the six names and the scripted summon failed with UNKNOWN_TOOL'
    : verdict === 'partial'
      ? 'the header omits the names but no subagent call was attempted'
      : legA.verdict === 'fail'
        ? `the header still offers ${present.join(', ') || '(no header)'}`
        : `the summon did not fail as specified (code ${code ?? 'none'})`;
  const doc = [
    `arm=${arm}`,
    `legA header-tools=${legA.headerTools} denied-present=${present.length === 0 ? 'none' : present.join(',')} verdict=${legA.verdict}`,
    `legB tool-call=${legB.toolCall} result-error=${legB.resultError} code=${code ?? 'none'} name=${errorName ?? 'none'} text=${JSON.stringify(legB.text)} verdict=${legB.verdict}`,
    `DENY ${verdict.toUpperCase()} arm=${arm} reason=${reason}`,
    '',
  ].join('\n');
  return { legA, legB, verdict, doc };
}

/**
 * Static deny check (subagent-deny.md leg A, config form): read a
 * `--dump-config` document and report, per deny row id, whether the composed
 * row carries `disabled: true`. No YAML dependency: the dump is a flat list of
 * `- id: <row>` blocks, and a row's own keys sit at two-space indent.
 * @param {string} text
 * @returns {{row: string, disabled: boolean}[]}
 */
function dumpRowStates(text) {
  const states = [];
  let current = null;
  for (const line of text.split(/\r?\n/u)) {
    const id = line.match(/^- id: (\S+)\s*$/u);
    if (id !== null) {
      current = { row: id[1], disabled: false };
      states.push(current);
      continue;
    }
    if (current !== null && /^\s+disabled: true\s*$/u.test(line)) current.disabled = true;
  }
  return states;
}

/**
 * Compose the config `--patch` actually produces and report what it did to the
 * host's tool-result pruner row.
 *
 * `patch.yml` stating `disabled: true` proves what was WRITTEN; the composed
 * document is what the host will mount, and that is the fact every run depends
 * on since ADR-0041. The row can compose more than once (the dump repeats a
 * patched row per layer that touches it), so every composed copy of the id is
 * reported. `applied` means every copy is disabled — the racoons arm's expected
 * state; the vanilla arm expects `rows > 0, disabledRows === 0` instead, and the
 * post-run gate reads the arm's own state from `hostPrunerState`.
 *
 * The composed document is written into the evidence dir, so a reviewer reads
 * the same bytes the verdict came from instead of trusting a boolean.
 * @param {{binJs: string, patchPath: string, armDir: string, homeDir: string,
 *   outFile: string}} input
 * @returns {{applied: boolean, source: string, rows: number, disabledRows: number,
 *   error: string|null}}
 */
function isolationState({ binJs, patchPath, armDir, homeDir, outFile }) {
  // A composed-config read is still a child process; it gets the allow-list
  // too, so no inherited credential can reach a dump.
  const env = { ...childEnvBase(), DSH_HOME: homeDir };
  mkdirSync(homeDir, { recursive: true });
  const run = spawnSync(process.execPath, [binJs, '--profile', 'headless', '--patch', patchPath, '--dump-config'], {
    encoding: 'utf8', windowsHide: true, env, cwd: armDir, maxBuffer: 32 * 1024 * 1024,
  });
  const text = run.stdout ?? '';
  writeFileSync(outFile, text);
  if (run.status !== 0) {
    return { applied: false, source: `${basename(outFile)} (dsh --dump-config exited ${String(run.status)})`,
      rows: 0, disabledRows: 0, error: (run.stderr ?? '').trim().split(/\r?\n/u)[0] ?? 'no stderr' };
  }
  const rows = dumpRowStates(text).filter((state) => state.row === HOST_PRUNER_ID);
  const disabledRows = rows.filter((state) => state.disabled).length;
  const applied = rows.length > 0 && disabledRows === rows.length;
  return {
    applied,
    source: `${basename(outFile)}: dsh --dump-config over patch.yml, ${String(disabledRows)}/`
      + `${String(rows.length)} composed tool-result-pruner row(s) disabled`,
    rows: rows.length,
    disabledRows,
    error: applied ? null
      : rows.length === 0 ? 'the composed config carries no tool-result-pruner row at all'
        : `${String(rows.length - disabledRows)} of ${String(rows.length)} composed row(s) are still enabled`,
  };
}

/** Recursively sort object keys so two runs serialise byte-identically. */
function sortedDeep(value) {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortedDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * The matcher keys one main request carries: how many tool results the host had
 * sent back, and which tools the newest assistant message called. This is the
 * pair the converter keys a replay on, so it is both what the projection stores
 * and what the fidelity gate compares against the served script.
 * @param {object[]} mains - `kind: 'main'` rows from requests.jsonl.
 * @returns {{tool_results_count: number, last_assistant_tool_names: string[]}[]}
 */
function requestKeys(mains) {
  return mains.map((entry) => {
    const messages = Array.isArray(entry.body?.messages) ? entry.body.messages : [];
    const toolResults = messages
      .filter((message) => message?.role === 'user' && Array.isArray(message.content))
      .flatMap((message) => message.content)
      .filter((block) => block?.type === 'tool_result').length;
    const lastAssistant = [...messages].reverse().find((message) => message?.role === 'assistant');
    const names = (Array.isArray(lastAssistant?.content) ? lastAssistant.content : [])
      .filter((block) => block?.type === 'tool_use')
      .map((block) => String(block.name));
    return { tool_results_count: toolResults, last_assistant_tool_names: names };
  });
}

/**
 * How many numbered rows the last user message of a request carries, or null
 * when it carries no table heading. The count is read after the heading so the
 * worked row inside the shipped system prompt is never counted. Evidence only:
 * since ADR-0028 there is one table lane, so nothing routes on a row count.
 * @param {object|null} body - a requests.jsonl `body`.
 * @returns {number|null}
 */
function tableRowCount(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((message) => message?.role === 'user');
  const text = Array.isArray(lastUser?.content)
    ? lastUser.content.filter((block) => block?.type === 'text').map((block) => block.text).join('')
    : typeof lastUser?.content === 'string' ? lastUser.content : '';
  const at = text.indexOf('Units still in memory, by assigned index.');
  if (at < 0) return null;
  return [...text.slice(at).matchAll(/^(\d+)\. \[/gmu)].length;
}

/**
 * The keys the SERVED script claims, turn by turn. The script is the spec: this
 * reads `match.tool_results_count` and `match.last_assistant_tool_names` as
 * written, defaulting an absent field to the only value the first request can
 * have (no tool results, no prior tool call).
 * @param {object[]} replies - `script.json` replies, in order.
 * @returns {{name: string, tool_results_count: number, last_assistant_tool_names: string[]}[]}
 */
function scriptKeys(replies) {
  return replies.map((entry) => ({
    name: String(entry?.name),
    tool_results_count: entry?.match?.tool_results_count ?? 0,
    last_assistant_tool_names: Array.isArray(entry?.match?.last_assistant_tool_names)
      ? entry.match.last_assistant_tool_names.map((name) => String(name)) : [],
  }));
}

/**
 * The tool-failure multiset the served script must produce, derived from the
 * script and the arm bytes — both outside the run being judged.
 *
 * Two host rules decide the codes, and both are modelled here because a replay
 * hits them:
 *  - a replayed `edit` carries `old_string` prose from a foreign repository, so
 *    it fails `FS_EDIT_NOT_FOUND` whenever the arm's copy does not contain that
 *    text; and
 *  - `fs-observation-policy` refuses a write or edit to a target this session
 *    has not READ first (`FS_NOT_OBSERVED`), and refuses an edit to a target it
 *    observed as absent (`FS_NOT_FOUND`). A write to an unseen target is a
 *    create-if-absent, which becomes `FS_NOT_OBSERVED` when the file already
 *    exists (`dsh-fs-local` `throwGuardedCreateFailure`). A record made in
 *    another harness edits files without the read the policy demands, so these
 *    are expected, named outcomes — not defects.
 *
 * Simulation is deliberately shallow: read (into) | edit (one replacement of
 * the first occurrence) | write (whole-file content), plus the observation
 * state those calls record. Only failure/success is read back.
 * @param {object} scriptDoc - parsed `<evidence>/script.json`.
 * @param {string} armRoot - the frozen arm (the run's copy starts byte-identical).
 * @returns {{count: number, by_code: object, by_tool: object, detail: object[]}}
 */
function expectedToolFailures(scriptDoc, armRoot) {
  const content = new Map();
  /** Per target: what this session has observed (`present` after a read or a
   * successful write, `absent` after a read of a missing file). */
  const observed = new Map();
  const textOf = (target) => {
    if (content.has(target)) return content.get(target);
    let text = null;
    try {
      text = readFileSync(join(armRoot, target), 'utf8');
    } catch {
      text = null;
    }
    content.set(target, text);
    return text;
  };
  const pairs = new Map();
  const detail = [];
  const bump = (tool, code) => {
    const key = `${tool}\u0000${code}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
    detail.push({ tool, code });
  };
  for (const entry of Array.isArray(scriptDoc?.replies) ? scriptDoc.replies : []) {
    const calls = Array.isArray(entry?.reply?.calls) ? entry.reply.calls : [];
    for (const call of calls) {
      const input = call?.input !== null && typeof call?.input === 'object' ? call.input : {};
      const target = typeof input.file_path === 'string' ? input.file_path : null;
      if (call?.name === 'read' && target !== null) {
        // A read records what it saw; a missing file records absence and fails
        // on its own (that is the path map's gate, not this one).
        observed.set(target, textOf(target) === null ? 'absent' : 'present');
      } else if (call?.name === 'edit' && target !== null) {
        const seen = observed.get(target);
        if (seen === undefined) bump('edit', 'FS_NOT_OBSERVED');
        else if (seen === 'absent') bump('edit', 'FS_NOT_FOUND');
        else {
          const before = textOf(target);
          const oldText = typeof input.old_string === 'string' ? input.old_string : null;
          // The byte decision is `edit-replay.mjs`'s, a pure module the test
          // pins without spawning a run. Only the observation bookkeeping above
          // stays here.
          const outcome = applyScriptedEdit(before, oldText, input.new_string);
          if (outcome.code !== undefined) bump('edit', outcome.code);
          else if (outcome.text !== null) content.set(target, outcome.text);
        }
      } else if (call?.name === 'write' && target !== null) {
        const seen = observed.get(target);
        if (seen === 'present') {
          content.set(target, typeof input.content === 'string' ? input.content : '');
        } else if (textOf(target) !== null) {
          // create-if-absent against a file that is already there.
          bump('write', 'FS_NOT_OBSERVED');
        } else {
          content.set(target, typeof input.content === 'string' ? input.content : '');
          observed.set(target, 'present');
        }
      }
    }
  }
  const byCode = {};
  const byTool = {};
  for (const [key, count] of pairs) {
    const [tool, code] = key.split('\u0000');
    byCode[code] = (byCode[code] ?? 0) + count;
    byTool[tool] = (byTool[tool] ?? 0) + count;
  }
  return { count: detail.length, by_code: byCode, by_tool: byTool, detail };
}

/**
 * The table-ask row's outcome (thirteenth audit item 7, fifteenth item 4).
 *
 * A run that sent no table ask answered nothing, so the row is `vacuous` on
 * BOTH arms: the population is empty and an empty population is never a
 * measured pass. The arms differ only in the failing direction — the vanilla
 * arm has no mount, so an ask there is red (a mount leaked); the racoons arm
 * fails when an answered ask missed the prune lane.
 * @param {{arm: string, asks: object[]}} input
 * @returns {{ok: boolean, class: string, detail?: string}}
 */
export function tableAskOutcome({ arm, asks }) {
  const rows = Array.isArray(asks) ? asks : [];
  if (arm !== 'racoons') {
    return rows.length === 0
      ? { ok: true, class: 'vacuous',
        detail: 'the vanilla arm has no mount and sent no table ask; there was nothing to answer' }
      : { ok: false, class: 'failed',
        detail: `the vanilla arm has no mount but sent ${String(rows.length)} table ask(s)` };
  }
  if (rows.length === 0) {
    return { ok: true, class: 'vacuous',
      detail: 'the racoons arm sent no table ask; the prune lane answered nothing on this run' };
  }
  const wrong = rows.filter((entry) => !String(entry.matched).startsWith('prune-table-forgetall-'));
  if (wrong.length === 0) {
    return { ok: true, class: 'measured',
      detail: `${String(rows.length)} table ask(s) were answered by the prune lane` };
  }
  return { ok: false, class: 'failed',
    detail: `${String(wrong.length)} of ${String(rows.length)} table ask(s) missed the prune lane, `
      + `first matched ${String(wrong[0]?.matched)}` };
}

/**
 * The tool-failure multiset comparison (thirteenth audit item 7). When the
 * script expects no failure, a green row is `vacuous`: there is no failure to be
 * exact about. The observed side is the projection's `tool_failures`, the
 * expected side a simulation over the served script and the arm's bytes.
 * @param {{observed: object, expected: object, firstUnexpected?: string|null}} input
 * @returns {{ok: boolean, class: string, detail?: string}}
 */
export function toolFailureOutcome({ observed, expected, firstUnexpected = null }) {
  const seen = observed ?? { count: -1, by_code: {}, by_tool: {} };
  const want = expected ?? { count: 0, by_code: {}, by_tool: {} };
  const sameCount = seen.count === want.count;
  const sameCodes = JSON.stringify(sortedDeep(seen.by_code)) === JSON.stringify(sortedDeep(want.by_code));
  const sameTools = JSON.stringify(sortedDeep(seen.by_tool)) === JSON.stringify(sortedDeep(want.by_tool));
  if (sameCount && sameCodes && sameTools) {
    return Number(want.count) === 0
      ? { ok: true, class: 'vacuous',
        detail: 'the served script expects no tool failure; there is no failure to compare' }
      : { ok: true, class: 'measured',
        detail: `${String(want.count)} failure(s) ${JSON.stringify(want.by_code)} over ${JSON.stringify(want.by_tool)}` };
  }
  return { ok: false, class: 'failed',
    detail: `expected ${String(want.count)} failure(s) ${JSON.stringify(want.by_code)} `
      + `over ${JSON.stringify(want.by_tool)}, saw ${String(seen.count)} ${JSON.stringify(seen.by_code)} `
      + `over ${JSON.stringify(seen.by_tool)}`
      + `${firstUnexpected === null ? '' : `; first unexpected: ${firstUnexpected}`}` };
}

/**
 * The readable world roots (ISSUE-039, ISSUE-235 item 5): the arm tree, or the
 * `--world` root when one was named. The evidence dir is the harness's own
 * output and is NEVER a root; a tool call naming it is an `evidence-path`
 * violation, not an inside read.
 * @param {{world: string|null, armDir: string}} input
 * @returns {string[]}
 */
export function readWorldRoots({ world, armDir }) {
  return world === null ? [armDir] : [world];
}

/**
 * The read boundary's named row (ISSUE-039, ISSUE-235 item 5). `judged` is the
 * number of paths the classifier classified; zero means no tool/call named a
 * path the scan judges, so `inside: 0` is an empty subject, not a clean world.
 * The row is `not-applicable` with its reason and never contributes to
 * `passed`; a nonzero judged pass stays a measured pass.
 * @param {{judged: number, violations: object[]}} input
 * @returns {true|string|{ok: true, class: string, detail: string}}
 */
export function readBoundaryGate({ judged, violations }) {
  if (judged === 0 && violations.length === 0) {
    return { ok: true, class: 'not-applicable',
      detail: 'read boundary: 0 path(s) judged — no tool/call in the session log named an absolute '
        + 'or parent-relative path, so this check was not exercised; inside: 0 does not mean the '
        + 'world was clean' };
  }
  return violations.length === 0 ? true
    : `${String(violations.length)} out-of-scope call(s): `
      + violations.slice(0, 5).map(describeReadViolation).join('; ');
}

/**
 * One assertion row (thirteenth audit item 7, fourteenth audit item 3).
 *
 * Every row carries `class` and `contributesToPassed`, so a reader can tell a
 * measured pass from an empty one. Classes:
 *   - `measured`: the row's subject was present and the row could fail — two
 *     artifacts compared, or a rule over one artifact with a non-empty population;
 *   - `vacuous`: the population was empty, so the row could not fail;
 *   - `not-applicable`: the row does not apply to this run;
 *   - `void`: the run asked to proceed past a refusal (`--allow-zero-reasoning`),
 *     so the row states a known-void comparison and can never be a pass;
 *   - `stopped-expected`: a kill the run asked for (--stop-on-compaction);
 *   - `failed`: the row is red.
 * Only `measured` + `ok` contributes to the pass count.
 * @param {string} name
 * @param {unknown} outcome - `true`, a failure string, or `{ok, detail?, class?}`.
 * @param {{class?: string}} [options]
 * @returns {{name: string, ok: boolean, class: string, contributesToPassed: boolean, detail?: string}}
 */
export function assertionRow(name, outcome, options = {}) {
  let ok = false;
  let detail;
  if (outcome !== null && typeof outcome === 'object') {
    ok = outcome.ok === true;
    detail = outcome.detail;
    if (!ok && detail === undefined) detail = 'expectation not met';
  } else {
    ok = outcome === true;
    if (!ok) detail = typeof outcome === 'string' ? outcome : 'expectation not met';
  }
  const declared = options.class
    ?? (outcome !== null && typeof outcome === 'object' && typeof outcome.class === 'string'
      ? outcome.class : 'measured');
  const kind = ok ? declared : 'failed';
  return { name, ok, class: kind, contributesToPassed: ok && kind === 'measured',
    ...(detail === undefined ? {} : { detail }) };
}

/**
 * The counts a reader compares: measured passes, failures, and the classes that
 * are recorded but do not count as a pass. `void` is the
 * `--allow-zero-reasoning` row: it is green by the runner's exit, and it must
 * never inflate the measured count (fourteenth audit item 3).
 * @param {object[]} results - `assertionRow` rows.
 * @returns {{total: number, measured: number, failed: number, vacuous: number,
 *   notApplicable: number, void: number, stoppedExpected: number}}
 */
export function assertionSummaryOf(results) {
  const rows = Array.isArray(results) ? results : [];
  const count = (kind) => rows.filter((row) => row.class === kind).length;
  return {
    total: rows.length,
    measured: rows.filter((row) => row.ok && row.class === 'measured').length,
    failed: rows.filter((row) => !row.ok).length,
    vacuous: count('vacuous'),
    notApplicable: count('not-applicable'),
    void: count('void'),
    stoppedExpected: count('stopped-expected'),
  };
}

/**
 * The budget stop's note. A grant fires either on a live child (the tree was
 * killed) or on the launcher's FINAL read after the child had already exited
 * (`reap` returned false): the ceiling was still crossed, but nothing needed
 * killing, so the note must not claim a kill or say the task never completed.
 * When `benchDone.found` is true the note states it instead of contradicting it.
 * @param {{killLanded: boolean, benchDoneFound: boolean}} input
 * @returns {string}
 */
export function budgetStopNote({ killLanded, benchDoneFound }) {
  const total = 'Censored partial by budget: the token grant fired at the true total above '
    + '(main prompt + main completion + ask prompt + ask completion + '
    + 'compaction prompt + compaction completion)';
  if (killLanded) {
    return `${total}, so the tree was killed`
      + (benchDoneFound
        ? ', and the task\'s done event is present (benchDone.found=true)'
        : ' and the task never completed')
      + '. Not a failure; claims are gated on benchDone.found, never passed';
  }
  return `${total} at the final read after the child had already exited; the ceiling was crossed `
    + 'and nothing needed killing'
    + (benchDoneFound
      ? ', and the task\'s done event is present (benchDone.found=true). '
      : '; no done event was recorded (benchDone.found=false). ')
    + 'Not a failure; claims are gated on benchDone.found, never passed';
}

/**
 * The ask lane's completeness, the value `watchdog.askComplete` and
 * `stop.budget.askComplete` both carry. `null` means this arm configures no ask
 * lane at all (the vanilla arm mounts nothing): there is no lane whose spend
 * the true total is missing, so no bound is claimed. A configured lane is
 * complete only when its journal was found and every prune table carried a
 * usage row and every line parsed; an absent journal or any unmeasured spend is
 * `false`, and the run label states the true total is a lower bound.
 * @param {{askLaneConfigured: boolean, askLane: object|null}} input
 * @returns {boolean|null}
 */
export function askLaneCompleteness({ askLaneConfigured, askLane }) {
  if (!askLaneConfigured) return null;
  return askLane !== null && askLane.known === true
    && askLane.pruneAsks === 0 && askLane.unparsed === 0;
}

/**
 * Whether this run owes a BENCH-DONE marker. `--require-done` is the explicit
 * flag for every lane; a completed real route owes the marker regardless,
 * because a child that exits 0 without it is a completed process, not a
 * completed task. A stopped run is a censored partial and already not passed;
 * it does not owe a marker its stop was designed to prevent.
 * @param {{provider: string, requireDone?: boolean, stopReason?: string|null,
 *   doneFound?: boolean}} input
 * @returns {{required: boolean, ok: boolean, detail?: string}}
 */
export function benchDoneRequirement({ provider, requireDone = false, stopReason = null,
  doneFound = false }) {
  const required = requireDone === true
    || (REAL_PROVIDERS.has(provider) && (stopReason === null || stopReason === undefined));
  if (!required) return { required: false, ok: true };
  return {
    required: true,
    ok: doneFound === true,
    detail: doneFound === true
      ? 'an assistant message carried BENCH-DONE'
      : 'no assistant message carried BENCH-DONE; a real-route exit 0 without the marker is not a pass',
  };
}

/**
 * The run-level label (`result.json.citableAs`), decided AFTER the assertions
 * are collected. A stopped run is a censored partial and names what stopped it;
 * a budget stop says "by budget" in the glossary's own words. A run with a
 * failed assertion is not a measurement either: the label is `none` and names
 * the first failure, so a completed run with a red fidelity row cannot keep a
 * measurement label (2026-11-09 audit item 6). Only a green run keeps the
 * reasoning/removal label built earlier. An incomplete ask lane makes the
 * grant's true total a lower bound, and the label says so (`askComplete:
 * false`); `null` means there is no bound to state (no grant, or an arm with
 * no ask lane configured).
 * @param {{stopReason: string|null, citableAs: string, failures?: object[],
 *   largestCheckpointReached?: number, expectedDeliverables?: number|null,
 *   benchDoneFound?: boolean,
 *   readBoundaryJudged?: number|null, askComplete?: boolean|null}} input
 * @returns {string}
 */
export function runCitableAs({ stopReason, citableAs, failures = [], largestCheckpointReached = 0,
  expectedDeliverables = null, benchDoneFound = false, readBoundaryJudged = null, askComplete = null }) {
  // A zero-judged boundary was not exercised, so the label states it instead of
  // reading as a clean measurement (ISSUE-235 item 5).
  const boundary = readBoundaryJudged === 0
    ? '; read boundary not exercised (judged: 0)' : '';
  // The true total is only a lower bound when the ask lane is incomplete; the
  // counts behind it live in `result.json.watchdog` and `result.json.stop.budget`.
  const lowerBound = askComplete === false
    ? '; true total is a lower bound (ask lane incomplete)' : '';
  // The denominator is the brief's own list; absent for an older result whose
  // list is unknown, so the historical `k=N` shape stays readable.
  const ofExpected = expectedDeliverables === null || expectedDeliverables === undefined
    ? '' : ` of ${String(expectedDeliverables)}`;
  if (stopReason === 'budget') {
    return `none (censored partial by budget at k=${String(largestCheckpointReached)}${ofExpected}; `
      + `benchDone.found=${String(benchDoneFound)})${boundary}${lowerBound}`;
  }
  if (stopReason !== null && stopReason !== undefined) {
    return `none (censored partial at k=${String(largestCheckpointReached)}${ofExpected}; `
      + `benchDone.found=${String(benchDoneFound)})${boundary}${lowerBound}`;
  }
  if (failures.length > 0) {
    return `none (${String(failures.length)} assertion(s) failed; first: ${String(failures[0]?.name)})`
      + boundary + lowerBound;
  }
  return `${citableAs}${boundary}${lowerBound}`;
}

/**
 * The green line (thirteenth audit item 8, fifteenth audit items 2 and 4). It
 * states `citableAs`, the applied-removal count and the native-compaction count
 * on the SAME line as PASS: an `--allow-zero-reasoning` run exits 0 while
 * `result.json` says no reasoning was measured, a live run can be green with
 * zero product removals (a control, not a removal measurement), and a compaction
 * that opened is a fact the reader must not have to open the JSON to find.
 * @param {{arm: string, provider: string, results: object[], citableAs: string,
 *   denySkipped: boolean, verdict: string, legBScored: string,
 *   removals?: number, compacted?: number}} input
 * @returns {string}
 */
export function passLineFor({ arm, provider, results, citableAs, denySkipped, verdict, legBScored,
  removals = null, compacted = null }) {
  const summary = assertionSummaryOf(results);
  return `PASS ${arm} (${provider}): ${String(summary.total)} assertion(s) `
    + `(${String(summary.measured)} measured, ${String(summary.vacuous)} vacuous, `
    + `${String(summary.notApplicable)} not applicable`
    // A void comparison is stated on the same line that also names `citableAs`
    // (fourteenth audit item 3); when no row is void the line is unchanged.
    + `${summary.void > 0 ? `, ${String(summary.void)} void` : ''})`
    + `, citableAs="${citableAs}"`
    // The removal count is the product's own applied lanes. `removals=0` is the
    // label that keeps a zero-removal run from reading as a removal measurement.
    + `${removals === null ? '' : `, removals=${String(removals)}`}`
    // The host's native compactions, on every provider (fifteenth audit item 4).
    + `${compacted === null ? '' : `, compacted=${String(compacted)}`}`
    + `${denySkipped ? '' : `, deny probe ${verdict}`
      + `${legBScored === 'expected' ? ' (leg B expected on the real route)' : ''}`}\n`;
}

/**
 * The `--plugin-entry`/`--arm vanilla` refusal (fifteenth audit item 7). The
 * vanilla arm loads no mount, so the flag was silently ignored: a command that
 * named an entry looked like it mounted something. `--preflight` is exempt: it
 * composes a config and spends nothing, and the flag cannot mount anything there
 * either; a LAUNCH is the silent act this refuses. Returns the refusal text, or
 * null when the combination is fine.
 * @param {{arm: string, pluginEntry: string|null, preflight?: boolean}} input
 * @returns {string|null}
 */
export function vanillaPluginEntryRefusal({ arm, pluginEntry, preflight = false }) {
  if (arm !== 'vanilla' || pluginEntry === null || pluginEntry === undefined) return null;
  if (preflight === true) return null;
  return '--plugin-entry has no effect on --arm vanilla (the vanilla arm loads no mount); '
    + 'refusing the combination rather than ignoring it';
}

/** Filenames the racoons mount could write into an evidence dir. */
const JOURNAL_NAMES = new Set(['cremator-events.jsonl']);
const LEDGER_NAMES = new Set(['ledger.sqlite', 'racoons-ledger.sqlite']);

/**
 * The journal lines, parsed and counted. The kinds are the ones the shipped
 * entry actually writes (`dev/dsh-rig/rig-plugin.mjs` adds `rig-mount`):
 * `mounted`, `capabilities`, `entry`, `at-rest`, `publish`, `skip`, `telemetry`,
 * `entry-error`, `at-rest-error`. Counting the raw kinds is not enough to read
 * cap/seal/recall, because a cap is a *field* of a `publish` record, so the
 * counts that matter are derived here.
 *
 * A recall id reaches the journal by one of two routes. A record that was
 * published carries `archives[].recallId`; an applied entry or revert writes no
 * `publish` record at all, so its recall ids are stated by the application
 * telemetry (`kind: "telemetry"`, `event.kind: "application"`,
 * `event.outcome: "applied"`, `event.recallIds`). Both routes feed `recallIds`,
 * deduplicated, so a reader never has to require one and ignore the other.
 * @param {object[]} events - parsed journal lines, in order.
 */
function journalCounts(events) {
  const byKind = {};
  let capArchives = 0;
  let evictArchives = 0;
  let verdictArchives = 0;
  // Every publish archive, whatever its operationKind. `capArchiveGate` reads it
  // to tell "no cap" from "no archive at all" (fourteenth audit item 5).
  let archiveTotal = 0;
  let sealEpisodes = 0;
  let negativeFacts = 0;
  let recalls = 0;
  let failedResultSkips = 0;
  // The mount's own usage lane (2026-11-09 audit item 5b): one
  // `usage-reconciled` line per assistant step whose usage it read, carrying the
  // billed prompt; `usage-missing` is the step it could not read. Both counts and
  // the sum are what the journal-to-session gate below compares.
  let usageReconciledInputTokens = 0;
  const ruleIds = {};
  const recallIds = [];
  const seenRecallIds = new Set();
  const addRecallId = (id) => {
    if (typeof id !== 'string' || seenRecallIds.has(id)) return;
    seenRecallIds.add(id);
    recallIds.push(id);
  };
  for (const event of events) {
    const kind = typeof event?.kind === 'string' ? event.kind : '(no-kind)';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (kind === 'publish') {
      for (const archive of Array.isArray(event.archives) ? event.archives : []) {
        const operation = String(archive?.operationKind ?? 'unknown');
        const rule = String(archive?.ruleId ?? 'unknown');
        ruleIds[rule] = (ruleIds[rule] ?? 0) + 1;
        addRecallId(archive?.recallId);
        archiveTotal += 1;
        if (operation === 'cap') capArchives += 1;
        else if (operation === 'evict') evictArchives += 1;
        else if (operation === 'verdict') verdictArchives += 1;
      }
      sealEpisodes += Array.isArray(event.sealedEpisodeIds) ? event.sealedEpisodeIds.length : 0;
      negativeFacts += Array.isArray(event.appendRecords) ? event.appendRecords.length : 0;
    }
    if (kind === 'skip' && event.reason === 'failed-result') failedResultSkips += 1;
    if (kind === 'usage-reconciled') {
      const inputTokens = Number(event.inputTokens ?? 0);
      if (Number.isFinite(inputTokens)) usageReconciledInputTokens += inputTokens;
    }
    if (kind === 'telemetry' && event.event?.kind === 'recall') recalls += 1;
    // An applied entry or revert writes no `publish` record; its recall ids are
    // only on the application telemetry. Deduped with the published ids above.
    if (kind === 'telemetry' && event.event?.kind === 'application'
      && event.event.outcome === 'applied') {
      for (const id of Array.isArray(event.event.recallIds) ? event.event.recallIds : []) {
        addRecallId(id);
      }
    }
  }
  // The applied-removal lanes, counted from the same lines by the module the
  // fidelity gates read (`journal-fidelity.mjs`), so the gate and the record
  // can never describe the journal differently.
  const lanes = journalLanes(events);
  // The prune bar writes one `prune-threshold` line per step boundary that
  // evaluated it, so the raw kind count is EVALUATIONS, not fires. Every reader
  // that asks "how many times did the prune fire" reads `pruneFires`; the
  // evaluation count is kept beside it because it is a real reading of its own.
  // `countPruneFires` treats a pre-change line (no `crossed`) as a fire.
  return { byKind, capArchives, evictArchives, verdictArchives, archiveTotal, sealEpisodes, negativeFacts,
    recalls, failedResultSkips, ruleIds, recallIds,
    usageReconciled: byKind['usage-reconciled'] ?? 0,
    usageMissing: byKind['usage-missing'] ?? 0,
    usageReconciledInputTokens,
    pruneFires: countPruneFires(events),
    pruneThresholdEvaluations: byKind['prune-threshold'] ?? 0, ...lanes };
}

/**
 * `journalCounts` over only the bytes a resumed round appended.
 *
 * The post-run `journal` block describes the whole adopted file, which is right:
 * it is the mount's record of the session. The usage gate, though, compares the
 * journal against the new leg's session rows (the `usage` block is bounded at
 * `priorSeq`), so it must count the same population. `fromBytes` is the launch
 * boundary the launcher recorded in `resumedFrom.askJournals`; a line that does
 * not parse there is skipped rather than counted, which is the same refusal
 * `journalState` makes visible for the whole file.
 * @param {string} file
 * @param {number} fromBytes
 * @returns {ReturnType<typeof journalCounts>|null}
 */
function journalCountsAfter(file, fromBytes) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    return null;
  }
  const from = Number.isFinite(fromBytes) && fromBytes > 0 && fromBytes <= bytes.length
    ? fromBytes : 0;
  const events = [];
  for (const line of bytes.subarray(from).toString('utf8').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // A line split at the boundary is not a row; the file-level parse verdict
      // still names an unparsable append.
    }
  }
  return journalCounts(events);
}

/**
 * Open one ledger and collect the counts. `readOnly` is passed only for the
 * evidence file itself, so a normal read can never mutate evidence.
 * @param {string} databasePath
 * @param {boolean} readOnly
 */
function readLedgerCounts(databasePath, readOnly) {
  const db = new DatabaseSync(databasePath, { readOnly });
  try {
    const events = {};
    for (const row of db.prepare('SELECT kind, COUNT(*) AS n FROM ledger_events GROUP BY kind ORDER BY kind').all()) {
      events[String(row.kind)] = Number(row.n);
    }
    const applications = {};
    for (const row of db.prepare('SELECT operation_kind, COUNT(*) AS n FROM application_removals '
      + 'GROUP BY operation_kind ORDER BY operation_kind').all()) {
      applications[String(row.operation_kind)] = Number(row.n);
    }
    const recallIds = db.prepare('SELECT recall_id FROM recalls ORDER BY recall_id').all()
      .map((row) => String(row.recall_id));
    // Fourteenth audit item 4: the recall's bytes are stated by recall_parts
    // (source_sha256 must equal blob_sha256 by schema), and the gate below opens
    // the blob store with them. Read here, beside the ids, so the gate can never
    // compare ids while the bytes stay unread.
    const recallParts = db.prepare('SELECT recall_id, part_index, source_sha256, source_byte_length, '
      + 'blob_sha256 FROM recall_parts ORDER BY recall_id, part_index').all()
      .map((row) => ({
        recallId: String(row.recall_id),
        partIndex: Number(row.part_index),
        sourceSha256: row.source_sha256 === null ? null : String(row.source_sha256),
        sourceByteLength: row.source_byte_length === null ? null : Number(row.source_byte_length),
        blobSha256: row.blob_sha256 === null ? null : String(row.blob_sha256),
      }));
    const sealedEpisodeIds = db.prepare('SELECT episode_id FROM application_removals '
      + 'WHERE episode_id IS NOT NULL ORDER BY episode_id').all().map((row) => String(row.episode_id));
    // The APPLIED removal rows (fifteenth audit item 6). `application_removals`
    // is written at PREPARE time (`commit-preparation.ts` runs inside
    // `prepare`), so a row alone does not mean the host spliced anything; the
    // applied intent is the one with a `ledger_events` row of kind `applied`.
    // A pre-schema ledger cannot state this: the read is null, and the gate
    // fails by name instead of passing on silence.
    const applied = (() => {
      try {
        const byKind = {};
        for (const row of db.prepare('SELECT operation_kind, COUNT(*) AS n FROM application_removals '
          + "WHERE intent_id IN (SELECT intent_id FROM ledger_events WHERE kind = 'applied' "
          + 'AND intent_id IS NOT NULL) GROUP BY operation_kind ORDER BY operation_kind').all()) {
          byKind[String(row.operation_kind)] = Number(row.n);
        }
        const recallIds = db.prepare('SELECT DISTINCT recall_id FROM application_removals '
          + "WHERE intent_id IN (SELECT intent_id FROM ledger_events WHERE kind = 'applied' "
          + 'AND intent_id IS NOT NULL) ORDER BY recall_id').all()
          .map((row) => String(row.recall_id));
        return { byKind, total: Object.values(byKind).reduce((sum, n) => sum + n, 0), recallIds };
      } catch {
        return null;
      }
    })();
    return { events, applications, recallIds, recallParts, sealedEpisodeIds, appliedRemovals: applied };
  } finally {
    db.close();
  }
}

/** The on-disk path the file blob store publishes a hash to (`sha256/xx/rest`). */
export function blobPathFor(blobRoot, sha256) {
  return join(blobRoot, 'sha256', sha256.slice(0, 2), sha256.slice(2));
}

/**
 * The recall-beside-removal gate (thirteenth audit item 3).
 *
 * The old gate returned true when the journal published no recall id, so an
 * empty set passed. Two rules replace it:
 *   - applied removals and no published recall is a FAIL: a closed episode that
 *     left the context must be restorable by an id the ledger holds, and a
 *     removal with no recall id has no restore path;
 *   - zero applied removals is `not-applicable`, never a pass. The row is
 *     recorded so a reader can see the recall lane was not exercised.
 * The expected side is every recall id the journal states — from a `publish`
 * archive where one exists, and from the applied-application telemetry for an
 * entry or revert, which writes no `publish` record (`journalCounts` unions
 * them) — and the actual side is the closed ledger's `recalls` table. A ledger
 * recall id that neither source names is a failure too: the ledger holds a
 * restore path the journal never recorded.
 *
 * Fourteenth audit item 4: an id in the `recalls` table proves a ROW, not a
 * byte. Every journal-stated recall's `recall_parts` rows are opened against the
 * blob store (`<sessionDir>/blobs/sha256/<xx>/<rest>`): a blob that is missing,
 * empty, or does not hash to both `source_sha256` and `blob_sha256` fails the
 * gate. A journal-stated recall with no part row fails too — there is nothing to
 * restore.
 * @param {{recallIds: string[], removals: number, ledgerRecallIds: string[],
 *   recallParts?: object[]|null, blobRoot?: string|null}} input
 *   - `recallParts` as returned by the ledger read; `blobRoot` is the session's
 *     `blobs/` directory.
 * @returns {{ok: boolean, class: string, detail?: string, blobsChecked?: number}}
 */
export function recallLedgerGate({
  recallIds, removals, ledgerRecallIds, recallParts = null, blobRoot = null,
}) {
  const wanted = Array.isArray(recallIds) ? recallIds : [];
  const applied = Number(removals ?? 0);
  const held = Array.isArray(ledgerRecallIds) ? ledgerRecallIds : [];
  // The ledger may hold a recall id neither journal source names — a restore
  // path with no journal record of how it was issued. Name it rather than
  // passing on the ids that did agree.
  const unbacked = [...new Set(held)]
    .filter((id) => !wanted.includes(id));
  if (unbacked.length > 0) {
    return { ok: false, class: 'failed',
      detail: `${String(unbacked.length)} ledger recall id(s) are absent from both the journal's `
        + `publish records and its applied-application telemetry: ${unbacked.join(', ')}` };
  }
  if (wanted.length === 0) {
    if (applied > 0) {
      return { ok: false, class: 'failed',
        detail: `${String(applied)} removal(s) were applied but the journal recorded no recall id `
          + '(neither a publish archive nor applied-application telemetry); '
          + 'a closed episode removed from the context must be restorable by a recall id the ledger holds' };
    }
    return { ok: true, class: 'not-applicable',
      detail: 'no removal was applied, so no recall was owed; the recall lane was not exercised' };
  }
  const missing = wanted.filter((id) => !held.includes(id));
  if (missing.length > 0) {
    return { ok: false, class: 'failed',
      detail: `${String(missing.length)} published recall id(s) are absent from the ledger: ${missing.join(', ')}` };
  }
  // The ids exist; now the bytes. No part table handed to the gate is a refusal:
  // a gate that silently skipped the byte check is exactly the defect item 4
  // names.
  if (blobRoot === null || typeof blobRoot !== 'string' || blobRoot === '') {
    return { ok: false, class: 'failed',
      detail: 'the ledger\'s blob root was not read, so the published recalls cannot be hashed' };
  }
  if (!Array.isArray(recallParts)) {
    return { ok: false, class: 'failed',
      detail: 'the ledger\'s recall_parts were not read, so the published recalls cannot be hashed' };
  }
  const problems = [];
  let blobsChecked = 0;
  for (const id of wanted) {
    const parts = recallParts.filter((part) => part?.recallId === id);
    if (parts.length === 0) {
      problems.push(`${id} has no recall_parts row, so there are no bytes to restore`);
      continue;
    }
    for (const part of parts) {
      const blobSha = typeof part.blobSha256 === 'string' ? part.blobSha256 : null;
      const sourceSha = typeof part.sourceSha256 === 'string' ? part.sourceSha256 : null;
      const label = `${id} part ${String(part.partIndex)}`;
      if (blobSha === null || sourceSha === null) {
        problems.push(`${label} states no blob_sha256/source_sha256`);
        continue;
      }
      if (blobSha !== sourceSha) {
        problems.push(`${label} blob_sha256 ${blobSha} differs from source_sha256 ${sourceSha}`);
        continue;
      }
      const file = blobPathFor(blobRoot, blobSha);
      let bytes;
      try {
        bytes = readFileSync(file);
      } catch (error) {
        problems.push(`${label} blob ${blobSha} is missing at ${file}`
          + `${error?.code === 'ENOENT' ? '' : ` (${String(error?.message ?? error)})`}`);
        continue;
      }
      if (bytes.length === 0) {
        problems.push(`${label} blob ${blobSha} is empty`);
        continue;
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== blobSha || digest !== sourceSha) {
        problems.push(`${label} blob hashes to ${digest}, not source_sha256/blob_sha256 ${blobSha}`);
        continue;
      }
      if (typeof part.sourceByteLength === 'number' && part.sourceByteLength !== bytes.length) {
        problems.push(`${label} blob is ${String(bytes.length)} B but source_byte_length says `
          + `${String(part.sourceByteLength)}`);
        continue;
      }
      blobsChecked += 1;
    }
  }
  if (problems.length > 0) {
    return { ok: false, class: 'failed', blobsChecked,
      detail: `${String(problems.length)} published recall byte check(s) failed: ${problems.slice(0, 5).join('; ')}`
        + `${problems.length > 5 ? `, and ${String(problems.length - 5)} more` : ''}` };
  }
  return { ok: true, class: 'measured', blobsChecked,
    detail: `${String(wanted.length)} published recall id(s) are in the ledger and all `
      + `${String(blobsChecked)} blob(s) hash to source_sha256/blob_sha256` };
}

/**
 * Where a racoons mock-replay run's durable ledger can be. The PRIMARY path is
 * derived exactly as the rig driver derives it (`dev/dsh-rig/run.mjs`,
 * `expect.racoons`): the storage root the wrapper names, then the one session
 * directory the run left, then its `ledger.sqlite` (ADR-0013). The LEGACY path
 * is the pre-bb33dc7 host-injected file and is only a fallback; `deprecated` is
 * true whenever it is the one that answered, so an evidence dir cannot hide
 * which seam produced it.
 * @param {string} racoonsEvidence - `<evidence>/racoons`.
 * @returns {{primary: string, legacy: string, storageRoot: string, sessionIds: string[]}}
 */
function ledgerPaths(racoonsEvidence) {
  const storageRoot = join(racoonsEvidence, CREMATOR_STORAGE_DIR);
  const sessionsDir = join(storageRoot, 'sessions');
  let sessionIds = [];
  try {
    sessionIds = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    // No storage root: the primary path is a placeholder that names the shape.
  }
  // More than one session dir is not expected (one dsh session per run), but
  // the one that actually holds a ledger wins over directory order.
  const withLedger = sessionIds.find((id) => existsSync(join(sessionsDir, id, 'ledger.sqlite')));
  const primary = join(sessionsDir, withLedger ?? sessionIds[0] ?? '<sessionId>', 'ledger.sqlite');
  return { primary, legacy: join(racoonsEvidence, LEGACY_LEDGER_FILE), storageRoot, sessionIds };
}

/**
 * Read a ledger's append-only record, without mutating the evidence file. The
 * rig does the same through `dev/dsh-rig/inspect-ledger.mjs`; the bench needs
 * counts, not a recall check, so it reads the sqlite file itself and imports
 * nothing from the dist tree.
 *
 * Two reads, in this order: the evidence file read-only (a cleanly closed
 * ledger opens there), then a temp copy opened read-write. The copy exists
 * because the mount never closes a host-supplied ledger, so the file is still
 * in WAL form when the child exits; replaying that WAL needs a writable
 * connection, and the evidence bytes must not be the thing that gets written.
 * A ledger the mount never opened is reported absent; one that cannot be read is
 * reported by name rather than thrown, because this is evidence collection.
 * Exported so the fourteenth-audit test can prove the read carries the
 * `recallParts` rows and the `blobRoot` the byte gate opens.
 * @param {string|null} ledgerPath
 */
export function ledgerState(ledgerPath) {
  // The file blob store lives beside the ledger (`storage.ts`: each session
  // derives `blobRoot = join(sessionDir, 'blobs')`), so the recall gate can open
  // it without a second path parameter (fourteenth audit item 4).
  const blobRoot = ledgerPath === null ? null : join(dirname(ledgerPath), 'blobs');
  const absent = { present: false, file: ledgerPath, bytes: null, readable: false, via: null,
    events: {}, applications: {}, recallIds: [], recallParts: [], sealedEpisodeIds: [],
    appliedRemovals: null, blobRoot, error: null };
  if (ledgerPath === null || !existsSync(ledgerPath)) return absent;
  // The byte read is evidence collection too, so an unreadable file is reported
  // by name, never thrown out of the report stage (ISSUE-581).
  let bytes;
  try {
    bytes = readFileSync(ledgerPath).length;
  } catch (unread) {
    return { present: true, file: ledgerPath, bytes: null, readable: false, via: null, events: {},
      applications: {}, recallIds: [], recallParts: [], sealedEpisodeIds: [],
      appliedRemovals: null, blobRoot,
      error: `ledger bytes unreadable: ${unread instanceof Error ? unread.message : String(unread)}` };
  }
  try {
    return { present: true, file: ledgerPath, bytes, readable: true, via: 'evidence',
      ...readLedgerCounts(ledgerPath, true), blobRoot, error: null };
  } catch (direct) {
    const scratch = mkdtempSync(join(tmpdir(), 'racoons-bench-ledger-'));
    try {
      const copy = join(scratch, 'ledger.sqlite');
      copyFileSync(ledgerPath, copy);
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${ledgerPath}${suffix}`)) copyFileSync(`${ledgerPath}${suffix}`, `${copy}${suffix}`);
      }
      return { present: true, file: ledgerPath, bytes, readable: true, via: 'copy',
        ...readLedgerCounts(copy, false), blobRoot, error: null };
    } catch (copied) {
      return { present: true, file: ledgerPath, bytes, readable: false, via: 'copy', events: {},
        applications: {}, recallIds: [], recallParts: [], sealedEpisodeIds: [],
        appliedRemovals: null, blobRoot,
        error: copied instanceof Error ? copied.message
          : direct instanceof Error ? direct.message : String(copied) };
    } finally {
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* temp only */ }
    }
  }
}

/**
 * What the racoons mount actually emitted, found by scanning the evidence dir's
 * top level and the mount's own `<evidence>/racoons/` dir, then parsing every
 * journal line and reading the ledger. The mount that runs in mock-replay is the
 * rig wrapper, so both files are expected artifacts: a missing journal is a
 * failed assertion, not a state to narrate.
 * @param {string[]} roots - dirs to scan.
 * @param {{primary: string, legacy: string, storageRoot: string, sessionIds: string[]}|null} ledgerPlan
 *   - the paths this run's mount can have written; null when no wrapper mounted.
 * @returns {{emitted: boolean, verdict: string, files: object[], journal: object|null,
 *   ledger: object, unparsable: object[]}}
 */
export function journalState(roots, ledgerPlan = null) {
  const files = [];
  const unparsable = [];
  const events = [];
  let journalFile = null;
  let journalBytes = null;
  const seen = new Set();
  for (const root of roots) {
    if (root === null || !existsSync(root)) continue;
    // One level only: a mount that gains a sink writes at its configured path,
    // never deep inside the work copy, and walking that tree (1787 files) would
    // cost more than the answer is worth.
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!JOURNAL_NAMES.has(name) && !LEDGER_NAMES.has(name)) continue;
      const full = join(root, name);
      if (seen.has(full)) continue;
      seen.add(full);
      const bytes = readFileSync(full);
      const record = { file: full, bytes: bytes.length, kind: JOURNAL_NAMES.has(name) ? 'journal' : 'ledger' };
      files.push(record);
      if (record.kind !== 'journal') continue;
      const lines = bytes.toString('utf8').split(/\r?\n/u).filter((line) => line.trim() !== '');
      journalFile = full;
      journalBytes = bytes.length;
      record.lines = lines.length;
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          unparsable.push({ file: full, line: line.slice(0, 120) });
        }
      }
    }
  }
  const counts = journalCounts(events);
  // The per-session path is authoritative; the old host-injected file is a
  // deprecated fallback, used only when the primary is absent and recorded as
  // such so the evidence never silently describes the pre-bb33dc7 seam.
  const chosen = ledgerPlan === null ? files.find((file) => file.kind === 'ledger')?.file ?? null
    : existsSync(ledgerPlan.primary) ? ledgerPlan.primary
      : existsSync(ledgerPlan.legacy) ? ledgerPlan.legacy
        : ledgerPlan.primary;
  const ledger = {
    ...ledgerState(chosen),
    ...(ledgerPlan === null ? {} : {
      primary: ledgerPlan.primary,
      legacy: ledgerPlan.legacy,
      storageRoot: ledgerPlan.storageRoot,
      sessionIds: ledgerPlan.sessionIds,
      deprecated: chosen === ledgerPlan.legacy,
    }),
  };
  return {
    emitted: journalFile !== null,
    verdict: journalFile === null ? 'absent' : unparsable.length === 0 ? 'parsed' : 'unparsable',
    files,
    journal: journalFile === null ? null
      : { file: journalFile, bytes: journalBytes, lines: events.length + unparsable.length,
        // The mount-only line, kept so the presence gate can demand something
        // only the mount writes (ISSUE-082). The first `mounted` record wins;
        // the mount emits exactly one per apply.
        mounted: events.find((event) => event?.kind === 'mounted') ?? null,
        ...counts },
    ledger,
    unparsable,
  };
}

/**
 * The vanilla arm's product-artifact gate (fifteenth audit item 1). The control
 * must prove NO removals from evidence, not only no mount from config: any
 * racoons journal or ledger file found in the evidence dir — including the
 * per-session durable ledger a mount would open — fails this row by name.
 * @param {ReturnType<typeof journalState>} journal
 * @returns {{ok: boolean, class: string, detail: string}}
 */
export function vanillaEvidenceGate(journal) {
  const artifacts = (Array.isArray(journal?.files) ? journal.files : []).map((file) => file.file);
  const ledgerFile = journal?.ledger?.present === true ? journal.ledger.file : null;
  if (ledgerFile !== null && ledgerFile !== undefined && !artifacts.includes(ledgerFile)) {
    artifacts.push(ledgerFile);
  }
  return artifacts.length === 0
    ? { ok: true, class: 'measured',
      detail: 'no racoons journal or ledger was found in the evidence dir' }
    : { ok: false, class: 'failed',
      detail: `the vanilla arm emitted racoons evidence: ${artifacts.join(', ')}` };
}

/**
 * The journal-to-session usage gate (2026-11-09 audit item 5b). Two artifacts
 * written by two code paths must state one population: the mount writes one
 * `usage-reconciled` line per assistant step whose usage it read and
 * `usage-missing` for a step it could not, while the session log carries one
 * usage row per assistant turn. A step in the session that the journal never
 * saw (or a journal row with no turn behind it) means one side lost spend; the
 * reconciled input sum must also equal the billed prompt the session rows sum.
 * @param {{counts: object|null, assistantTurns: number,
 *   billedPromptTokens: number}} input
 * @returns {{ok: boolean, class: string, detail?: string}}
 */
export function journalUsageGate({ counts, assistantTurns, billedPromptTokens }) {
  if (counts === null || counts === undefined) {
    return { ok: false, class: 'failed', detail: 'no journal to read the usage rows from' };
  }
  const reconciled = Number(counts.usageReconciled ?? 0);
  const missing = Number(counts.usageMissing ?? 0);
  const turns = Number(assistantTurns ?? 0);
  const journalInput = Number(counts.usageReconciledInputTokens ?? 0);
  const billed = Number(billedPromptTokens ?? 0);
  if (reconciled + missing === 0 && turns === 0) {
    return { ok: true, class: 'not-applicable',
      detail: 'no assistant turn and no journal usage row; the usage lane was not exercised' };
  }
  const problems = [];
  if (reconciled + missing !== turns) {
    problems.push(`the journal records ${String(reconciled)} usage-reconciled and `
      + `${String(missing)} usage-missing row(s), the session log carries `
      + `${String(turns)} assistant turn(s)`);
  }
  if (journalInput !== billed) {
    problems.push(`the journal's reconciled input is ${String(journalInput)} tokens, `
      + `usage.billedPromptTokens is ${String(billed)}`);
  }
  return problems.length === 0
    ? { ok: true, class: 'measured',
      detail: `${String(reconciled)} usage-reconciled and ${String(missing)} usage-missing row(s) cover `
        + `${String(turns)} assistant turn(s); reconciled input ${String(journalInput)} = billed prompt` }
    : { ok: false, class: 'failed', detail: problems.join('; ') };
}

/**
 * The served script truncated to the replies that held the first `calls`
 * scripted tool calls. Used only when a host compaction cut the replay short:
 * the expected tool-failure multiset must then describe the calls that ran,
 * not the calls the full record would have reached.
 * @param {object} doc - parsed `<evidence>/script.json`.
 * @param {number} calls - how many `tool/call` events the session log holds.
 * @returns {object} a script document with the same shape, shortened.
 */
function prefixScript(doc, calls) {
  const replies = [];
  let taken = 0;
  for (const entry of Array.isArray(doc?.replies) ? doc.replies : []) {
    const width = Array.isArray(entry?.reply?.calls) ? entry.reply.calls.length : 0;
    if (taken >= calls) break;
    replies.push(entry);
    taken += width;
  }
  return { ...doc, replies };
}

/**
 * The size of the tool results the model actually saw, in bytes, read from the
 * session log's `tool/result` rows. The filler asks the scripted command to
 * print N bytes; the host's post-execute caps decide what reaches the model, so
 * this is the measurement that keeps the flag honest about delivered size.
 * @param {object[]} sessionEvents
 * @returns {{count: number, min: number, median: number, max: number}}
 */
function deliveredResultBytes(sessionEvents) {
  const sizes = sessionEvents
    .filter((event) => event.type === 'tool/result')
    .map((event) => {
      const blocks = event?.data?.message?.content ?? [];
      return Array.isArray(blocks)
        ? blocks.filter((block) => block?.type === 'text')
          .reduce((sum, block) => sum + Buffer.byteLength(String(block.text ?? ''), 'utf8'), 0)
        : 0;
    })
    .sort((a, b) => a - b);
  if (sizes.length === 0) return { count: 0, min: 0, median: 0, max: 0 };
  return {
    count: sizes.length,
    min: sizes[0],
    median: sizes[Math.floor(sizes.length / 2)],
    max: sizes[sizes.length - 1],
  };
}

/**
 * The canonical projection of one mock-replay run: the facts that must be the
 * same in two runs of the same arm, and nothing else.
 *
 * Dropped on purpose, because they move between runs and comparing them would
 * make every run differ: timestamps and durations, absolute evidence paths, the
 * mock's port, the fabricated usage rows, the title request (it races process
 * exit), and the terminator's ordinal (it encodes how many turns the scripted
 * prefix holds, so a `maxReplies` change moves it). Never include tool-result
 * text: it carries the work copy's absolute path.
 *
 * @param {{arm: string, provider: string, scriptSha256: string,
 *   mains: object[], sessionEvents: object[], toolResultRows: object[]}} input
 * @returns {object}
 */
function buildProjection({ arm, provider, scriptSha256, mains, sessionEvents, toolResultRows }) {
  const requests = requestKeys(mains);
  // The terminator's name embeds the number of scripted calls (`replay-end-tr20`),
  // which moves with `maxReplies`. Its presence is the fact; the ordinal is not.
  const matched = mains.map((entry) => String(entry.matched).replace(/^replay-end-tr\d+$/u, 'replay-end'));
  const calls = sessionEvents
    .filter((event) => event.type === 'tool/call')
    .map((event) => String(event.data?.name));
  const failures = toolResultRows.filter((row) => row.isError);
  const byCode = {};
  const byTool = {};
  for (const row of failures) {
    const code = row.code ?? 'no-code';
    byCode[code] = (byCode[code] ?? 0) + 1;
    byTool[row.tool] = (byTool[row.tool] ?? 0) + 1;
  }
  return sortedDeep({
    schema: PROJECTION_SCHEMA,
    arm,
    provider,
    script_sha256: scriptSha256,
    // The matcher keys the mock saw per main request, in request order.
    requests,
    // Which scripted reply answered each request. `replay-end` is the marker.
    matched,
    // Every tool call the host made, by name, in order.
    tool_calls: calls,
    // The replayed failures are a constant of a foreign record, not a defect:
    // five edits carry prose that cannot match the arm. Carried by name so a
    // baseline that silently lost or gained one shows here.
    tool_failures: { count: failures.length, by_code: byCode, by_tool: byTool },
  });
}

/**
 * Leaf-by-leaf difference between the stored projection and this run's.
 * Every entry names the key path, so a perturbation fails BY NAME.
 * @returns {{path: string, expected: unknown, actual: unknown}[]}
 */
function diffProjection(expected, actual) {
  const diffs = [];
  const walk = (want, saw, path) => {
    const wantArray = Array.isArray(want);
    const sawArray = Array.isArray(saw);
    if (wantArray || sawArray) {
      if (!wantArray || !sawArray) {
        diffs.push({ path: path === '' ? '<root>' : path, expected: want, actual: saw });
        return;
      }
      if (want.length !== saw.length) {
        diffs.push({ path: `${path}.length`, expected: want.length, actual: saw.length });
      }
      const shared = Math.min(want.length, saw.length);
      for (let i = 0; i < shared; i += 1) walk(want[i], saw[i], `${path}[${String(i)}]`);
      return;
    }
    const wantObject = want !== null && typeof want === 'object';
    const sawObject = saw !== null && typeof saw === 'object';
    if (wantObject || sawObject) {
      if (!wantObject || !sawObject) {
        diffs.push({ path: path === '' ? '<root>' : path, expected: want, actual: saw });
        return;
      }
      const keys = [...new Set([...Object.keys(want), ...Object.keys(saw)])].sort();
      for (const key of keys) {
        walk(want[key], saw[key], path === '' ? key : `${path}.${key}`);
      }
      return;
    }
    if (!Object.is(want, saw) && JSON.stringify(want) !== JSON.stringify(saw)) {
      diffs.push({ path: path === '' ? '<root>' : path, expected: want, actual: saw });
    }
  };
  walk(expected, actual, '');
  return diffs;
}

/**
 * Exchange two replies' matchers in the served script. The replies keep their
 * names and calls; only the keys that decide WHEN they are served move. Nothing
 * on disk that is committed is touched: the script this edits is the per-run
 * copy written into the evidence dir. A script broken this way must turn the
 * request-key gate red, so a swap that still passes is a vacuous gate.
 * @param {object} script - the built replay script, mutated in place.
 * @param {number[]} slots - two 1-based reply numbers.
 */
function swapMatchers(script, slots) {
  const replies = script.replies;
  for (const slot of slots) {
    if (slot > replies.length) {
      refuse(`bench-run.mjs: --perturb-swap-match ${String(slot)} is past the served script's `
        + `${String(replies.length)} replies`);
    }
  }
  const [a, b] = slots;
  const swap = replies[a - 1].match;
  replies[a - 1].match = replies[b - 1].match;
  replies[b - 1].match = swap;
}

/**
 * Find every composed row that could reach the OFFICIAL DeepSeek endpoint.
 *
 * Reads the `--dump-config` document the host actually composed, not the patch
 * file the launcher wrote: `patch.yml` is the intent, the dump is what mounts.
 * A row is a suspect when its id is in `officialIds` OR its own composed text
 * names `api.deepseek.com` or the `DEEPSEEK_API_KEY` ref. An ENABLED suspect is
 * a route that can spend the owner's official credits, so the caller fails.
 *
 * Scope note: this reads row blocks, so a nested config key that repeats a row
 * id is judged with its row, and a comment line closes the block the way the
 * dump's `# == <layer>` separators do.
 * @param {string} text - the `--dump-config` stdout.
 * @param {string[]} officialIds - row ids that are official routes by identity.
 * @returns {{id: string, enabled: boolean, why: string[], line: number}[]}
 */
function officialRouteState(text, officialIds) {
  const wanted = new Set(officialIds);
  const blocks = [];
  let current = null;
  text.split(/\r?\n/u).forEach((line, index) => {
    const id = /^- id: (\S+)\s*$/u.exec(line);
    if (id !== null) {
      current = { id: id[1], enabled: true, why: [], line: index + 1, text: '' };
      blocks.push(current);
      return;
    }
    if (current === null) return;
    if (/^#/u.test(line)) { current = null; return; }
    current.text += `${line}\n`;
    if (/^\s+disabled: true\s*$/u.test(line)) current.enabled = false;
  });
  const suspects = [];
  for (const block of blocks) {
    const why = [];
    if (wanted.has(block.id)) why.push('a row that is an official route by identity');
    if (/api\.deepseek\.com/u.test(block.text)) why.push('its composed config names api.deepseek.com');
    if (/DEEPSEEK_API_KEY/u.test(block.text)) why.push('its composed config names DEEPSEEK_API_KEY');
    if (why.length > 0) suspects.push({ id: block.id, enabled: block.enabled, why, line: block.line });
  }
  return suspects;
}

/**
 * The host-pruner requirement at the preflight seam (ADR-0041 Decision 6,
 * fifteenth audit item 3; arm rule 2026-11-09). The printed
 * `composed-disabled=N/M` line used to be "printed, not asserted", so a patch
 * whose row the composed config dropped printed `0/0` and PREFLIGHT PASS in the
 * same breath. The expected state is now the ARM's, never a run-wide one:
 *   - `racoons` (`disabled`): the composed config must carry at least one
 *     `tool-result-pruner` row and every copy must be disabled;
 *   - `vanilla` (`host-default`): the composed config must carry the row with
 *     NO copy disabled — the host's own default (on), left untouched. A
 *     composed disable row on the control is the mismatch this fails on.
 * @param {{arm: 'racoons'|'vanilla', allowHostPruner?: boolean, rows: object[]}} input
 *   `rows` are the `dumpRowStates` entries whose id is `tool-result-pruner`.
 * @returns {{ok: boolean, state: 'disabled'|'host-default', detail?: string}}
 */
export function preflightPrunerRequirement({ arm, allowHostPruner = false, rows }) {
  const composed = Array.isArray(rows) ? rows : [];
  const disabled = composed.filter((state) => state.disabled === true).length;
  const state = hostPrunerState(arm, allowHostPruner);
  if (state === HOST_PRUNER_DISABLED) {
    if (composed.length === 0) {
      return { ok: false, state, detail: `the composed config carries no ${HOST_PRUNER_ID} row, and the `
        + `racoons arm must disable it (ADR-0041): the pruner the run claims to disable is not the one composed` };
    }
    if (disabled === 0) {
      return { ok: false, state, detail: `the composed config disables 0/${String(composed.length)} `
        + `${HOST_PRUNER_ID} row(s): the racoons arm claims the host pruner off and the config leaves it enabled` };
    }
    if (disabled !== composed.length) {
      return { ok: false, state, detail: `${String(composed.length - disabled)} of ${String(composed.length)} composed `
        + `${HOST_PRUNER_ID} row(s) are still enabled` };
    }
    return { ok: true, state };
  }
  // `host-default`: the vanilla arm writes no row, so nothing may compose one
  // disabled. The row must still be present: its absence means the host default
  // this arm claims to measure is not the one composed.
  if (composed.length === 0) {
    return { ok: false, state, detail: `the composed config carries no ${HOST_PRUNER_ID} row, so the `
      + 'vanilla arm\'s host-default state cannot be confirmed' };
  }
  if (disabled > 0) {
    return { ok: false, state, detail: `the composed config disables ${String(disabled)}/${String(composed.length)} `
      + `${HOST_PRUNER_ID} row(s), but the vanilla arm leaves the host pruner at its host default` };
  }
  return { ok: true, state };
}

/**
 * The `--deny-web` requirement at the preflight seam. The four web rows are
 * denied by default, but `--allow-official-spend` skips that row set (the flag
 * authorizes the host, not a row), so an authorized official run must state the
 * deny explicitly and the preflight must prove the composed config carries it.
 *
 * An ABSENT row is not an enabled row: a build that no longer ships the plugin
 * cannot offer `web_search`/`web_fetch`, so absence is reported and passes. A
 * row present in the dump with no `disabled: true` is the failure this gate
 * exists for. The check is inert when `--deny-web` was not given: the default
 * row set already denies web on every run that did not open the official host.
 * @param {{denyWeb?: boolean, rows: object[]}} input - `rows` are the
 *   `dumpRowStates` entries whose id is one of `WEB_ROUTE_IDS`.
 * @returns {{ok: boolean, checked: boolean, enabled: string[], absent: string[],
 *   detail?: string}}
 */
export function preflightWebRequirement({ denyWeb = false, rows }) {
  const composed = Array.isArray(rows) ? rows : [];
  const enabled = WEB_ROUTE_IDS.filter((id) => composed.some((state) => state.row === id && state.disabled !== true));
  const absent = WEB_ROUTE_IDS.filter((id) => !composed.some((state) => state.row === id));
  if (denyWeb !== true) return { ok: true, checked: false, enabled, absent };
  if (enabled.length > 0) {
    return {
      ok: false, checked: true, enabled, absent,
      detail: `--deny-web was given but the composed config leaves ${enabled.join(', ')} enabled`,
    };
  }
  return { ok: true, checked: true, enabled, absent };
}

/**
 * The `--workspace-only` temp root: a `.tmp` directory inside the arm (or the
 * `--dry-work` copy) that the child's own `TEMP`, `TMP` and `TMPDIR` name.
 *
 * The failed 2026-11-08 2-option run staged `t2-*.txt` in the OS temp dir and
 * read it back; workspace-only refused the read because that path is outside
 * the arm world. This keeps such an intermediate list inside the workspace the
 * strict rule measures: the directory is created before spawn, and the
 * classifier's world-root check reports every path under it as `inside`, never
 * as campaign or outside.
 *
 * Every other run is untouched: `null` means no directory is created and the
 * inherited OS temp env (and the default OS temp allowance) stays in force.
 * @param {{workDir: string, workspaceOnly?: boolean}} input
 * @returns {{dir: string, env: {TEMP: string, TMP: string, TMPDIR: string}}|null}
 */
export function workspaceTempSetup({ workDir, workspaceOnly = false }) {
  if (workspaceOnly !== true) return null;
  const dir = resolve(workDir, '.tmp');
  return { dir, env: { TEMP: dir, TMP: dir, TMPDIR: dir } };
}

/**
 * The `--workspace-only` read rule. `classifyToolCalls` reports a path outside
 * the campaign as `outside` (recorded, not gated); workspace-only turns every
 * one of those rows into a violation so the run fails (exit 4) instead of
 * merely noting it. An `--allow-read` root is refused at parse time; a
 * `--allow-tool-root` (ISSUE-297) is classified `allowed`, never `outside`, so
 * it stays permitted and every other outside path still fails.
 * @param {object} report - the `classifyToolCalls` report.
 * @param {boolean} workspaceOnly
 * @returns {object} the same report, or one whose `outside` rows are violations
 */
export function workspaceOnlyReport(report, workspaceOnly) {
  if (workspaceOnly !== true) return report;
  const outside = Array.isArray(report.outside) ? report.outside : [];
  return {
    ...report,
    violations: [...report.violations, ...outside.map((row) => ({ ...row, scope: 'outside' }))],
    outside: [],
  };
}

/** Preflight: the composed config, spent nothing, named by its evidence dir. */function preflight(opts, binJs, evidenceDir, patchPath, pluginEntry, envPaths) {
  // The same allow-list the launched child gets. A denylist of two names let
  // every other provider credential reach this child (ISSUE-260/270).
  const env = { ...childEnvBase(), DSH_HOME: join(evidenceDir, 'home'), ...envPaths };
  mkdirSync(env.DSH_HOME, { recursive: true });
  const run = spawnSync(process.execPath, [binJs, '--profile', 'headless', '--patch', patchPath, '--dump-config'], {
    encoding: 'utf8', windowsHide: true, env, cwd: opts.armDir, maxBuffer: 32 * 1024 * 1024,
  });
  writeFileSync(join(evidenceDir, 'dump-config.yml'), run.stdout ?? '');
  if (run.status !== 0) {
    process.stderr.write(`bench-run.mjs: --dump-config exited ${String(run.status)}: ${(run.stderr ?? '').trim()}\n`);
    process.exit(1);
  }
  const states = dumpRowStates(run.stdout ?? '');
  // A deny row is satisfied when the id is composed and disabled, OR when the
  // build no longer ships that plugin at all: an absent plugin cannot offer a
  // tool, and dsh 0.2.2 folded `tool-subagent-list-agents` into
  // `tool-subagent-control`. Absence is reported beside the count, never folded
  // into it, so a reader can see which ids this host version no longer has. The
  // deny PROBE is still the hard gate: it reads the tools the model was actually
  // offered, so a tool that survives under a new id still fails the run.
  const absentDenyRows = DENY_ROW_IDS.filter((id) => !states.some((state) => state.row === id));
  const missing = DENY_ROW_IDS.filter((id) => {
    const rows = states.filter((state) => state.row === id);
    return rows.length > 0 && !rows.some((state) => state.disabled);
  });
  const official = officialRouteState(run.stdout ?? '', OFFICIAL_ROUTE_IDS);
  const exempt = officialRouteExemption(opts.provider);
  const officialProvider = officialRouteFor(opts.provider);
  const officialAuthorized = officialProvider !== null && opts.allowOfficialSpend;
  // `--deny-web` is a hard gate: an authorized official run skips the default
  // official row set, so the composed dump — not the patch text — is what proves
  // the four web rows are closed. An absent row passes by the same rule the
  // deny rows use: a plugin the build no longer ships cannot offer the tool.
  const webStates = states.filter((state) => WEB_ROUTE_IDS.includes(state.row));
  const webRequirement = preflightWebRequirement({ denyWeb: opts.denyWeb, rows: webStates });
  // An authorized official route may keep every official row open: the flag
  // authorizes the HOST, not a chosen row, and the owner ruling says official is
  // allowed only when explicitly named. Every other run keeps the old check.
  const officialOpen = officialAuthorized ? [] : official.filter((row) => row.enabled && row.id !== exempt);
  const mounted = pluginEntry !== null && (run.stdout ?? '').includes(pathToFileURL(pluginEntry).href);
  const configRows = states.filter((state) => state.row === 'racoons-mount');
  process.stdout.write(`preflight arm=${opts.arm} provider=${opts.provider}\n`);
  process.stdout.write(`composed rows=${String(states.length)} deny-rows-disabled=${String(DENY_ROW_IDS.length - missing.length)}/${String(DENY_ROW_IDS.length)}`
    + `${missing.length === 0 ? '' : ` missing: ${missing.join(',')}`}`
    + `${absentDenyRows.length === 0 ? '' : ` absent-in-this-build: ${absentDenyRows.join(',')}`}\n`);
  // The official-endpoint line is the proof this mode must print: every suspect
  // row the dump carries, and whether it is mounted or removed.
  process.stdout.write(`official-routes=${official.length === 0 ? 'none' : official
    .map((row) => `${row.id}:${row.enabled ? 'ENABLED' : 'disabled'}`
      + `${row.id === exempt ? '(exempt: the route transport this provider names)' : ''}`).join(',')}\n`);
  // The four web rows in one line: `disabled`, `ENABLED`, or `absent`. The
  // `denied` word is the flag's claim; the per-row states are what the composed
  // dump says, so the two cannot be read as the same fact.
  const webStateText = WEB_ROUTE_IDS.map((id) => {
    const copies = webStates.filter((state) => state.row === id);
    if (copies.length === 0) return `${id}:absent`;
    return `${id}:${copies.every((state) => state.disabled) ? 'disabled' : 'ENABLED'}`;
  }).join(',');
  process.stdout.write(`web-tools=${opts.denyWeb ? 'DENIED (--deny-web)' : 'not-asserted'} ${webStateText}\n`);
  process.stdout.write(`read-boundary=${opts.workspaceOnly
    ? 'workspace-only (a path outside the arm world fails the run)'
    : 'campaign line (a campaign read fails the run; a machine read is recorded)'}\n`);
  process.stdout.write(`stop-policy=checkpoint:${opts.stopAtCheckpoint ?? 'none'} `
    + `after-compactions:${opts.stopAfterCompactions === null ? 'none' : String(opts.stopAfterCompactions)}`
    + `${opts.stopAtCheckpoint === null && opts.stopAfterCompactions === null ? '' : ' (censored partial)'}\n`);
  if (officialProvider !== null) {
    // The line a reviewer reads first: this run named the official host, and
    // whether the flag authorized it. `REFUSED` is followed by a FAIL below.
    process.stdout.write(`official-route-provider=${officialProvider.endpoint} `
      + `spend=${officialAuthorized ? 'AUTHORIZED' : 'REFUSED'}`
      + `${officialAuthorized
        ? ' (--allow-official-spend: owner authorization 2026-11-05)'
        : ' (pass --allow-official-spend to authorize)'}\n`);
  }
  process.stdout.write(`mount-row=${pluginEntry === null ? 'not expected' : mounted ? 'present (file URL resolved)' : 'ABSENT'}`
    + `${opts.arm === 'racoons' ? ` racoons-mount-rows=${String(configRows.length)}` : ''}\n`);
  // ADR-0041 and the arm rule: preflight spends nothing and composes the real
  // config, so it is the cheapest place to read the pruner's state. Since the
  // fifteenth audit (item 3) the read is ASSERTED, not printed-only: a composed
  // config that disagrees with the ARM's expected state fails here, before any
  // process reaches a provider, so `PREFLIGHT PASS` can never stand beside
  // `0/0`. The racoons arm expects `disabled`; vanilla expects `host-default`.
  const prunerRows = states.filter((state) => state.row === HOST_PRUNER_ID);
  const prunerVerdict = preflightPrunerRequirement({
    arm: opts.arm, allowHostPruner: opts.allowHostPruner, rows: prunerRows,
  });
  process.stdout.write(`host-pruner=${prunerVerdict.state} `
    + `composed-disabled=${String(prunerRows.filter((state) => state.disabled).length)}/${String(prunerRows.length)}\n`);
  if (!prunerVerdict.ok) {
    process.stderr.write(`preflight FAIL: ${prunerVerdict.detail}\n`);
    process.exit(1);
  }
  if (missing.length > 0) {
    process.stderr.write(`preflight FAIL: rows not composed to disabled: ${missing.join(', ')}\n`);
    process.exit(1);
  }
  if (officialProvider !== null && !officialAuthorized) {
    process.stderr.write(`preflight FAIL: ${officialSpendRefusal(opts.provider, officialProvider)}\n`);
    process.exit(1);
  }
  if (officialOpen.length > 0) {
    process.stderr.write('preflight FAIL: a row that can reach the official DeepSeek endpoint is mounted: '
      + `${officialOpen.map((row) => `${row.id} (${row.why.join('; ')})`).join(', ')}\n`);
    process.exit(1);
  }
  if (!webRequirement.ok) {
    process.stderr.write(`preflight FAIL: ${webRequirement.detail}\n`);
    process.exit(1);
  }
  if (opts.arm === 'racoons' && !mounted) {
    process.stderr.write('preflight FAIL: the composed config names no racoons mount row\n');
    process.exit(1);
  }
  process.stdout.write(`PREFLIGHT PASS\n`);
}

async function main() {
  let opts;
  let task;
  let deliverables;
  try {
    opts = parseArgs(process.argv.slice(2));
    // A resume round's task is the whole `--task-file`, read raw and unbounded.
    // `--brief` is not opened at all: its fence and its cap belong to a round
    // that starts over, and the follow-up is new text. The same bytes are the
    // deliverable parser's input, so a final explicit list of bare names or
    // paths in the follow-up is the round's expected list, resolved against the
    // directory its text names; `--deliverables` still overrides it.
    let taskText;
    let briefText = '';
    if (opts.resume !== null) {
      task = readTaskFile(opts.taskFile);
      taskText = task;
      briefText = task;
    } else {
      const brief = readBrief(opts.brief);
      task = brief.task;
      taskText = brief.task;
      briefText = brief.text;
    }
    let deliverablesText = null;
    if (opts.deliverables !== null) {
      if (!existsSync(opts.deliverables)) {
        refuse(`bench-run.mjs: --deliverables file not found at ${opts.deliverables}`);
      }
      deliverablesText = readFileSync(opts.deliverables, 'utf8');
    }
    const keyRefusal = taskKeyRefusal(task);
    if (keyRefusal !== null) refuse(`bench-run.mjs: ${keyRefusal}`);
    deliverables = resolveBenchDeliverables({
      briefText,
      taskText,
      deliverablesText,
      sourceLabel: opts.deliverables,
    });
    if (deliverables.duplicates.length > 0) {
      refuse(`bench-run.mjs: the deliverable list repeats ${JSON.stringify(deliverables.duplicates)}; `
        + 'a repeated path would gate fewer files than the list states, so it is refused rather than deduped');
    }
  } catch (error) {
    refuse(error.message);
  }
  // One state for every artifact this run writes (owner ruling 2026-11-09):
  // the patch, launch.json, result.json and both assertions read this. The
  // parse above already refused an arm that is neither name, so this cannot
  // throw for a launched run.
  const prunerState = hostPrunerState(opts.arm, opts.allowHostPruner);
  if (!existsSync(opts.armDir)) {
    refuse(`bench-run.mjs: arm not found at ${opts.armDir}; run node dev/bench/prep.mjs first`);
  }
  // A checkpoint stop is armed on the file's APPEARANCE. A file already in the
  // arm would fire at the first poll and measure nothing, so it is refused
  // before anything is wiped — preflight included.
  if (opts.stopAtCheckpoint !== null) {
    const already = resolve(opts.armDir, opts.stopAtCheckpoint);
    if (existsSync(already)) {
      refuse(`bench-run.mjs: --stop-at-checkpoint ${opts.stopAtCheckpoint} already exists at ${already}; `
        + 'a stop at t=0 measures nothing (stage a fresh arm or name a file the run will create)');
    }
  }
  // A PAID route must name the round manifest (fifteenth audit item 5). Before
  // this gate a paid launch without `--manifest` bound the spend to no round and
  // left the brief and the arm image unverifiable. `--preflight` is exempt: it
  // spends nothing and composes the config, so it can run before a manifest
  // exists. `--plugin-entry` on the vanilla arm is refused too (item 7): the
  // vanilla arm loads no entry, so the flag would be silently ignored.
  {
    const pluginRefusal = vanillaPluginEntryRefusal({
      arm: opts.arm, pluginEntry: opts.pluginEntry, preflight: opts.preflight,
    });
    if (pluginRefusal !== null) refuse(`bench-run.mjs: ${pluginRefusal}`);
  }
  {
    const manifestGate = paidRouteManifestGate({
      paid: REAL_PROVIDERS.has(opts.provider) && !opts.preflight,
      manifest: opts.manifest,
    });
    if (!manifestGate.ok) refuse(`bench-run.mjs: ${manifestGate.detail}`);
  }
  // OFFICIAL-ROUTE OPT-IN (ISSUE-176 reversal, owner ruling 2026-11-05):
  // official is allowed only when explicitly named. A live run without the flag
  // refuses here, before anything is wiped or spawned. `--preflight` is exempt
  // from this early refusal on purpose: it composes the still-closed patch and
  // fails its own gate, so the artifact shows exactly what stayed shut.
  const officialRoute = officialRouteFor(opts.provider);
  if (officialRoute !== null && !opts.allowOfficialSpend && !opts.preflight) {
    refuse(officialSpendRefusal(opts.provider, officialRoute));
  }
  // The replay script is built before anything is wiped or spawned: a map that
  // does not bind this record (or names a file the arm lacks) is exit 2 while
  // the previous evidence dir is still intact.
  const replay = opts.provider === 'mock-replay' ? buildReplay(opts) : null;

  const requestedEvidenceDir = resolve(opts.resume
    ?? opts.evidence
    ?? (opts.world === null ? null : join(opts.world, 'evidence'))
    ?? join(REPO_ROOT, 'scratchpad', 'bench', CAMPAIGN,
      opts.provider === 'mock'
        ? `${opts.arm}-mock${opts.omitDenyRows ? '-perturb' : ''}${opts.preflight ? '-preflight' : ''}`
        : opts.provider === 'mock-replay'
          ? `${opts.arm}-mock-replay${opts.perturbSwapMatch === null ? '' : '-perturb'}${opts.preflight ? '-preflight' : ''}`
          : opts.preflight ? `${opts.arm}-preflight` : opts.arm));
  // `--preflight` never wipes a round. An existing non-empty evidence dir keeps
  // its bytes; the preflight writes under `<dir>/preflight` instead.
  const preflightNested = opts.preflight && nonEmptyDirectory(requestedEvidenceDir);
  const evidenceDir = preflightNested ? join(requestedEvidenceDir, 'preflight') : requestedEvidenceDir;
  if (preflightNested) {
    process.stdout.write(`preflight: ${requestedEvidenceDir} is non-empty; `
      + `the existing round is preserved and this preflight writes to ${evidenceDir}\n`);
  }
  const evidenceRefusal = evidenceDirRefusal({
    evidenceDir,
    armDir: opts.armDir,
    world: opts.world,
  });
  if (evidenceRefusal !== null) refuse(`bench-run.mjs: ${evidenceRefusal}`);
  // Every allow-read root is a claim about what the agent could read. A drive
  // root, this repo, the evidence dir, the work copy or a credential store
  // makes that claim false, so it is refused before anything is wiped.
  for (const root of opts.allowRead) {
    const refusal = allowReadRefusal({
      root,
      evidenceDir,
      workDir: opts.dryWork ? join(evidenceDir, 'work') : opts.armDir,
    });
    if (refusal !== null) refuse(`bench-run.mjs: ${refusal}`);
  }
  // A tool root (ISSUE-297: the deps-only venv interpreter) is the same kind of
  // claim as an allow-read root, so it is judged by the same rules. The helper's
  // sentences name --allow-read; the prefix names the flag that was actually used.
  for (const root of opts.allowToolRoots) {
    const refusal = allowReadRefusal({
      root,
      evidenceDir,
      workDir: opts.dryWork ? join(evidenceDir, 'work') : opts.armDir,
    });
    if (refusal !== null) refuse(`bench-run.mjs: --allow-tool-root: ${refusal}`);
  }
  const inside = pathInside;
  // A resume adopts the ONE session log already persisted under the evidence
  // dir. Discovery is read-only and runs before the archive: a dir with two
  // sessions (or none) must refuse while the previous record is still in place.
  let resume = null;
  if (opts.resume !== null) {
    const state = resumeSessionState(evidenceDir);
    if (!state.ok) refuse(`bench-run.mjs: --resume ${evidenceDir}: ${state.detail}`);
    resume = state;
  }
  // `--world` (ISSUE-039): the per-arm isolation contract. One directory holds
  // this arm's tree and this arm's evidence and NOTHING else, so `..` from the
  // child's cwd reaches no campaign artifact and no other arm. A world root that
  // already carries derivation or another arm's evidence dir is refused before
  // anything is wiped — that is the shape Run B launched into.
  if (opts.world !== null) {
    if (!inside(opts.world, opts.armDir)) {
      refuse(`bench-run.mjs: --world ${opts.world} must contain the arm (${opts.armDir})`);
    }
    if (!inside(opts.world, evidenceDir)) {
      refuse(`bench-run.mjs: --world ${opts.world} must contain the evidence dir (${evidenceDir}); `
        + 'leave --evidence at its default (<world>/evidence) or name a dir inside the world');
    }
    const problems = worldLayoutViolations({ worldRoot: opts.world, armDir: opts.armDir, evidenceDir });
    if (problems.length > 0) {
      refuse(`bench-run.mjs: --world ${opts.world} is not isolated:\n  ${problems.join('\n  ')}`);
    }
  }
  // The evidence dir is wiped at start. A projection living inside it would be
  // deleted before the comparison could read it (and the baseline would then be
  // this run's own output, which is the self-comparison the law forbids).
  for (const [flag, file] of [['--projection-in', opts.projectionIn], ['--projection-out', opts.projectionOut]]) {
    if (file !== null && inside(evidenceDir, file)) {
      refuse(`bench-run.mjs: ${flag} (${file}) must live outside the evidence dir (${evidenceDir}), `
        + 'which is wiped at start; keep the baseline beside the arm evidence dirs');
    }
  }

  // `--manifest`: the round manifest is the brief's own record. Asserted here,
  // before anything is wiped and before any process starts, so a stale brief or
  // a re-materialized arm is exit 2 rather than a run the reviewer must reject.
  // The arm's BYTES are hashed on every run before the launch (fifteenth audit
  // item 5): `manifestTaskGate` compares the arm's own `manifest.json`, and this
  // compares the tree on disk to the round manifest's `image.digest`, so a tree
  // re-materialized behind a stale `manifest.json` is caught too.
  let roundManifest = null;
  if (opts.manifest !== null && resume === null) {
    try {
      roundManifest = JSON.parse(readFileSync(opts.manifest, 'utf8'));
    } catch (error) {
      refuse(`bench-run.mjs: --manifest ${opts.manifest} is not readable JSON: ${error.message}`);
    }
    const armManifest = (() => {
      try {
        return JSON.parse(readFileSync(join(opts.armDir, 'manifest.json'), 'utf8'));
      } catch {
        return null;
      }
    })();
    const gate = manifestTaskGate({
      manifest: roundManifest,
      taskSha256: taskSha256(task),
      taskChars: task.length,
      armMultiset: armManifest?.totals?.multisetSha256 ?? null,
    });
    if (!gate.ok) {
      refuse(`bench-run.mjs: --manifest ${opts.manifest} does not bind this launch: ${gate.detail}`);
    }
    if (gate.skipped !== undefined) {
      process.stdout.write(`manifest: skipped (${gate.skipped})\n`);
    }
    // The manifest's own deliverable count is a second copy of the brief's
    // list. It used to be read by nothing, so a brief edited after the manifest
    // could gate fewer files than the manifest states. The comparison is here,
    // before anything is wiped.
    const countGate = manifestDeliverablesGate({ manifest: roundManifest, paths: deliverables.paths });
    if (!countGate.ok) {
      refuse(`bench-run.mjs: --manifest ${opts.manifest} does not bind this launch: ${countGate.detail}`);
    }
    if (countGate.skipped !== undefined) {
      process.stdout.write(`manifest deliverables: skipped (${countGate.skipped})\n`);
    }
  } else if (opts.manifest !== null) {
    // A resume round's task text is NEW, so the manifest's brief hash cannot
    // bind it; and the arm already holds the previous rounds' deliverables, so
    // its tree is not the frozen image the manifest names. Both gates are
    // stated as skipped rather than silently passed.
    process.stdout.write('manifest: task-hash and arm-tree gates skipped (resume: the task text is new '
      + 'and the arm holds prior deliverables)\n');
  }
  const treeBeforeLaunch = digestTree(opts.armDir);
  if (roundManifest !== null) {
    const treeGate = armTreeGate({
      manifest: roundManifest,
      digest: treeBeforeLaunch.digest,
      files: treeBeforeLaunch.files,
    });
    if (!treeGate.ok) {
      refuse(`bench-run.mjs: --manifest ${opts.manifest} does not bind this arm: ${treeGate.detail}`);
    }
  }

  // Real-provider preflight: an explicit opt-in, the credential store, and the
  // dist tree the mount needs. All three are checked before anything is wiped.
  const realApi = REAL_PROVIDERS.has(opts.provider);
  let credentialsPath = null;
  if (realApi) {
    if (process.env.BENCH_REAL_API !== '1' && !opts.preflight) {
      refuse(`bench-run.mjs: --provider ${opts.provider} needs BENCH_REAL_API=1; refusing to spend a real call `
        + '(--preflight composes the config and spends nothing, so it skips this gate)');
    }
    credentialsPath = join(homedir(), '.dsh', '.credentials.yaml');
    if (!existsSync(credentialsPath)) {
      refuse(`bench-run.mjs: the credential store is absent at ${credentialsPath} `
        + `(ref ${REAL_ROUTES[opts.provider].apiKeyEnv})`);
    }
  }
  let pluginEntry = null;
  let pluginDist = opts.pluginDist;
  // A racoons run on a journal-gated route (`mock-replay`, the live route) mounts the
  // rig wrapper. The wrapper loads the same shipped entry and supplies the two
  // seams the bench needs evidence from: a journal sink under
  // `<evidence>/racoons/` and the `crematorStorageRoot` the entry opens its own
  // per-session ledger under. Until ISSUE-082 this keyed on the replay alone, so
  // every real-API run mounted the shipped entry — whose default export has no
  // way to pass a sink — and threw its journal away.
  // `--plugin-entry` always wins: naming the shipped entry removes the sink and
  // turns the journal assertion red. The gate no longer depends on the entry
  // choice: every run scans the evidence dir (fifteenth audit item 1), so a
  // vanilla run is held to the same evidence.
  let rigWrapper = false;
  let journalGated = false;
  if (opts.arm === 'racoons') {
    if (opts.pluginDist === resolve(DEFAULTS.pluginDist)) {
      try {
        pluginDist = ensureDist({ quiet: true }).dir;
      } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
      }
    }
    ({ rigWrapper, journalGated } = chooseMountEntry({ arm: opts.arm, provider: opts.provider, pluginEntry: opts.pluginEntry }));
    pluginEntry = opts.pluginEntry ?? (rigWrapper ? RIG_WRAPPER : join(pluginDist, ...PLUGIN_ENTRY));
    if (!existsSync(pluginEntry)) {
      refuse(`bench-run.mjs: the ${rigWrapper ? 'rig wrapper' : 'shipped plugin entry'} is absent at ${pluginEntry}; `
        + 'build it with node dev/dsh-rig/build-dist.mjs (or pass --plugin-entry)');
    }
  }
  // Where the wrapper writes: the rig's own convention, `<evidence>/racoons/`.
  const racoonsEvidence = join(evidenceDir, CREMATOR_EVIDENCE_DIR);
  // The wrapper owns two harness paths: the journal sink dir and the storage
  // root the entry opens its own per-session ledger under (ADR-0013). No ledger
  // path is injected: that seam was removed from the wrapper at bb33dc7.
  const mountHarness = rigWrapper
    ? { evidenceDir: racoonsEvidence, storageRoot: join(racoonsEvidence, CREMATOR_STORAGE_DIR) }
    : null;
  if (opts.provider === 'mock' && !existsSync(opts.mockScript)) refuse(`bench-run.mjs: mock script not found at ${opts.mockScript}`);

  const binJs = resolveDshBin(opts.dshBin);
  // The FIRST child gets the same allow-listed env every later child gets. A
  // `--version` probe does not need a key, and an inherited one would be the
  // leak before the run starts.
  const version = spawnSync(process.execPath, [binJs, '--version'], {
    encoding: 'utf8', windowsHide: true, env: childEnvBase(),
  });
  const dshVersion = (version.stdout ?? '').trim();

  // Evidence is per run: a normal round wipes it, so a stale session log can
  // never satisfy it. A RESUME round is the opposite: the dir holds the session
  // it adopts and the previous round's record. It is created when missing, and
  // the previous `result.json`/`stdout.ndjson` are MOVED into `round-N/` so the
  // new round starts at the top level and every earlier round keeps its record.
  let roundArchive = null;
  if (resume === null) {
    // A preflight never wipes: it composes a config and spends nothing, and a
    // non-empty evidence dir was already redirected to `<dir>/preflight`.
    if (!opts.preflight) rmSync(evidenceDir, { recursive: true, force: true });
    mkdirSync(evidenceDir, { recursive: true });
  } else {
    mkdirSync(evidenceDir, { recursive: true });
    roundArchive = archiveResumeRound(evidenceDir);
  }
  if (rigWrapper) mkdirSync(racoonsEvidence, { recursive: true });
  // ── The resume accounting boundary for the ask lane ───────────────────────
  // The adopted journal still holds every earlier leg's ask rows. A resumed
  // round is judged on THIS launch, so both ask readers (the in-run watchdog
  // and the post-run `askLane`) start where the journal ended before the child
  // was spawned. The snapshot is taken here, after the archive and before
  // anything can append, and `resumedFrom.askJournals` records it in the
  // artifact. This is a byte boundary, not a timestamp or seq: the journal is
  // the only file the mount writes, and its byte length is exactly the split
  // between the prior leg and this one. A normal round wipes the dir, so it
  // needs no boundary and keeps byte 0.
  const resumeAskOffsets = resume === null ? null : askJournalOffsets(evidenceDir, { dir: true });
  writeFileSync(join(evidenceDir, 'task.txt'), `${task}\n`);
  writeLaunchRecord(evidenceDir, process.argv.slice(2), opts);
  const briefSha = taskSha256(task);
  const patchPath = writePatch(evidenceDir, opts,
    pluginEntry === null ? null : pathToFileURL(pluginEntry).href, mountHarness);
  const patchSha = sha256File(patchPath);
  // The patch's own row count, recorded with the pruner state. The read is from
  // the bytes just written, so the record cannot drift from the artifact.
  const patchTally = patchRowTally(readFileSync(patchPath, 'utf8'));

  // `--preflight` stops here: the composed config is the artifact, no process
  // reaches the provider and no arm is touched.
  if (opts.preflight) {
    preflight(opts, binJs, evidenceDir, patchPath, pluginEntry, credentialsPath === null ? {} : {
      RIG_CREDENTIALS_PATH: credentialsPath,
      RIG_SESSIONS_DIR: join(evidenceDir, 'sessions'),
      RIG_STORAGES_DIR: join(evidenceDir, 'storages'),
    });
    return;
  }

  const homeDir = realApi ? join(homedir(), '.dsh') : join(evidenceDir, 'home');
  // A resume round's session root is the one its adopted log lives under:
  // `<evidence>/sessions`. The live route already used that path; a mock-lane
  // resume is held to it too, so the boundary read and the post-run read see
  // the SAME file the child continued.
  const sessionsDir = realApi || resume !== null
    ? join(evidenceDir, 'sessions') : join(homeDir, 'sessions');
  const storagesDir = realApi ? join(evidenceDir, 'storages') : join(homeDir, 'storages');
  if (!realApi) mkdirSync(homeDir, { recursive: true });
  if (realApi || resume !== null) {
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(storagesDir, { recursive: true });
  }

  // Work dir: the arm itself, or a scratch copy that keeps the arm pristine.
  let workDir = opts.armDir;
  let workMode = 'arm';
  let copied = 0;
  let treeBefore = null;
  if (opts.dryWork) {
    workDir = join(evidenceDir, 'work');
    mkdirSync(workDir, { recursive: true });
    // The same pre-launch digest the manifest gate used: the arm was not
    // touched between that read and this copy, so a second hash would only
    // describe the same bytes twice.
    treeBefore = treeBeforeLaunch;
    copied = copyTree(opts.armDir, workDir);
    workMode = 'dry-work';
  }

  // The resume round's baseline, read BEFORE the launch: which expected
  // deliverables the previous rounds already left in the work dir. The gate
  // compares the post-run rows against this, so a prior file is `prior` and the
  // new round is judged by what it ADDED.
  let resumeBaseline = null;
  if (resume !== null) {
    const priorRows = deliverableRowsFor(deliverables.paths, workDir);
    resumeBaseline = {
      expected: deliverables.paths.length,
      present: priorRows.filter((row) => row.present).map((row) => row.path),
      missing: priorRows.filter((row) => !row.present).map((row) => row.path),
      rows: priorRows,
    };
  }

  // Is the pruner really off? `patch.yml` saying `disabled: true` is the intent;
  // the COMPOSED config is what the child mounts, and since ADR-0041 that holds
  // for every run, not only a pressure one. Compose it in the same cwd the child
  // gets (dsh resolves its plugins from there), before the run, and keep the
  // dump in the evidence dir as the proof a reviewer can re-read.
  const isolation = isolationState({
    binJs,
    patchPath,
    armDir: workDir,
    // A throwaway home: composition must not touch the run's own session roots.
    homeDir: join(evidenceDir, 'home-isolation'),
    outFile: join(evidenceDir, 'dump-config-host-pruner.yml'),
  });

  const scriptPath = join(evidenceDir, 'script.json');
  const requestLog = join(evidenceDir, 'requests.jsonl');
  writeFileSync(requestLog, '');
  let mock = null;
  let mockOut = [];
  let mockErr = [];
  let mockExit = Promise.resolve({ code: null, signal: null });
  let flushMockLogs = () => {};
  let port = null;
  if (!realApi) {
    // Same evidence convention in both mock modes: the script the mock will
    // serve is `<evidence>/script.json`. `mock` copies the fixture there;
    // `mock-replay` writes the converted, rewritten, terminator-appended form,
    // with the racoons arm's prune rows in FRONT of the record's main turns
    // (the mock takes the first match, so an ask is answered before any main
    // row is considered — see `pruneReplyRows`).
    if (replay === null) writeFileSync(scriptPath, readFileSync(opts.mockScript));
    else writeFileSync(scriptPath, `${canonicalScript(servedReplayScript(replay))}\n`);
    mock = spawn(process.execPath, [
      MOCK,
      '--port', String(opts.port),
      '--log', requestLog,
      '--script', scriptPath,
      '--expect-api-key', DUMMY_KEY,
    ], { cwd: evidenceDir, windowsHide: true, env: childEnvBase() });
    mock.stderr.on('data', (chunk) => mockErr.push(chunk));
    mockExit = new Promise((resolveExit) => mock.on('exit', (code, signal) => resolveExit({ code, signal })));
    flushMockLogs = () => {
      writeFileSync(join(evidenceDir, 'mock.out.log'), Buffer.concat(mockOut));
      writeFileSync(join(evidenceDir, 'mock.err.log'), Buffer.concat(mockErr));
    };
    try {
      port = await new Promise((resolvePort, rejectPort) => {
        const lines = createInterface({ input: mock.stdout });
        const timer = setTimeout(() => rejectPort(new Error('the mock did not report listening within 15000 ms')), 15_000);
        lines.on('line', (line) => {
          mockOut.push(Buffer.from(`${line}\n`));
          try {
            const parsed = JSON.parse(line);
            if (parsed.event === 'listening' && Number.isInteger(parsed.port)) {
              clearTimeout(timer);
              resolvePort(parsed.port);
            }
          } catch {
            // Non-JSON diagnostics stay in mock.out.log.
          }
        });
        mock.on('exit', (code) => rejectPort(new Error(`the mock exited before listening (code ${code}); see mock.err.log`)));
      });
    } catch (error) {
      flushMockLogs();
      mock.kill();
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  } else {
    writeFileSync(scriptPath, '{}\n');
  }

  // `--workspace-only`: the child's temp root is inside the arm and is created
  // before spawn, so a task that stages an intermediate list in `$env:TEMP`
  // reads it back from the same world the strict rule measures. Every other
  // run creates nothing and keeps the inherited temp env and OS temp allowance.
  const workspaceTemp = workspaceTempSetup({ workDir, workspaceOnly: opts.workspaceOnly });
  if (workspaceTemp !== null) mkdirSync(workspaceTemp.dir, { recursive: true });

  // Allow-list, never `{ ...process.env }` minus names. `OPENAI_API_KEY`,
  // cloud keys and every other inherited secret are absent by construction.
  // The only key the child sees is the mock lane's DUMMY_KEY, below.
  const childEnv = { ...childEnvBase() };
  Object.assign(childEnv, {
    DSH_HOME: homeDir,
    // Python opens JSON as UTF-8 only when this is set; the host's default
    // codec on this box is GBK, so the child's python must not inherit a
    // possibly-unset value.
    PYTHONUTF8: '1',
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_PERMISSION_MODE: 'danger-full-access',
    // Strict mode moves the child's temp root inside the arm. The OS temp dir
    // is not a readable root under `--workspace-only`, so `$env:TEMP` must not
    // point at it; the arm-local `.tmp` is a world root and classifies inside.
    ...(workspaceTemp === null ? {} : workspaceTemp.env),
    // The rig wrapper refuses to guess which compiled tree to load. It names
    // the arm's own dist, so evidence and mount can never disagree about bytes.
    ...(rigWrapper ? { CREMATOR_RIG_DIST: pluginDist } : {}),
    ...(realApi
      ? {
        // A path, never the key: dsh resolves the route's apiKeyEnv name from
        // the store itself.
        RIG_CREDENTIALS_PATH: credentialsPath,
        RIG_SESSIONS_DIR: sessionsDir,
        RIG_STORAGES_DIR: storagesDir,
      }
      : { DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(port)}`, DEEPSEEK_API_KEY: DUMMY_KEY }),
  });

  // One patch layer; the deny rows sit at its end. The argv is recorded, so the
  // reviewer can read the composition order from result.json. A resume round
  // names the adopted session before the task channel, exactly as the rig does;
  // dsh headless sends one user message per process, so this is what continues
  // the prior conversation instead of starting a second one. The task itself
  // rides stdin (`-`): a >30 000-char brief no longer hits the Windows argv
  // limit, and the task (which may contain the owner's words) never appears in
  // a command line, a log, or the result's launchCommand.
  const argv = resume === null
    ? [binJs, '--profile', 'headless', '--patch', patchPath, '--json', '-']
    : [binJs, '--profile', 'headless', '--patch', patchPath, '--json',
      '--session-id', resume.sessionId, '-'];
  const launchCommand = [process.execPath, ...argv].map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part)).join(' ');
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const child = spawn(process.execPath, argv, {
    cwd: workDir, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  // A child that exits before reading stdin (a stub, or a crash) closes the
  // pipe; the task write must not throw an unhandled EPIPE.
  child.stdin.on('error', () => {});
  child.stdin.end(task);

  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
  // Resolve on `close`, not `exit`: `exit` can fire while stdout/stderr still
  // hold unread bytes, and the artifact is written from those chunks below
  // (ISSUE-581). `close` fires once every stdio stream is drained.
  const childExit = new Promise((resolveExit) => child.on('close', (code, signal) => resolveExit({ code, signal })));

  // ── Kill timer: armed before any wait ONLY when a positive cap was asked. ──
  // `--kill-ms 0` (the default) leaves the box OFF: the token grant is the only
  // cap. One command, three callers: the box, the token grant, and the SIGINT
  // reap. Each keeps its own precondition; the kill itself is identical by
  // construction, so the tree dies the same way however it is stopped.
  const watchdogCommand = `taskkill /PID ${String(child.pid)} /T /F`;
  const killTree = () => {
    if (child.pid !== undefined) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', env: childEnvBase() });
  };
  let watchdogFired = false;
  const watchdog = armKillBox({
    killMs: opts.killMs,
    onFire: () => {
      watchdogFired = true;
      killTree();
    },
  });
  const reap = () => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      killTree();
      return true;
    }
    return false;
  };
  // ── In-run token watchdog, armed beside the box and independent of it. ─────
  // The child is writing `session.v4.jsonl` under the sessions root; polling it
  // for `inputTokens + cacheReadTokens + cacheWriteTokens` is the only in-run
  // measure of billed prompt spend, and it is the same sum the product's reader
  // hands the meter. The kill is the SAME `killTree` the box and the SIGINT path
  // call, behind the same liveness guard they use, so the tree dies the same way
  // and the launcher exits through the same failure path: a grant reached is a
  // timeout, never a bench result. The guard matters here beyond tidiness: a
  // fired grant can land on the final poll, after the child has already exited,
  // and `taskkill /PID <stale pid>` could hit a recycled PID.
  const usageWatch = new SessionUsageWatch(sessionsDir);
  if (resume !== null) {
    // The adopted log already holds the previous rounds' spend. The grant is a
    // ceiling for THIS launch (the flag's own contract), so the tail starts
    // where the log ended before the launch: only what the new round appends is
    // counted. `bytes` is the same snapshot the boundary seq came from.
    const tail = new UsageTail(resume.file);
    tail.offset = resume.bytes;
    usageWatch.tails.set(resume.file, tail);
  }
  // The grant's true total includes the mount's ask lane, which never enters the
  // session log (`llm-ask.ts` journals its usage under the evidence dir). One
  // `AskSource` for the in-run watchdog; the post-run `askLane` below opens its
  // own reader over the finished journal. A resume round passes the launch
  // byte offsets, so the prior legs' ask rows are not counted against a grant
  // that was armed for this launch only.
  const tokenAskSource = new AskSource(evidenceDir, { dir: true, startOffsets: resumeAskOffsets });
  // `--stop-on-compaction` is a landmark, not a budget, so it arms the SAME
  // watchdog with a second stop condition instead of a second poller: one file
  // read per poll, one kill path, and the two can never both fire (the controller
  // guards them with one flag). The kill is `reap` — the box's own liveness
  // guard — so a compaction row that lands after the child exited is a no-op
  // rather than a `taskkill` against a recycled pid. `compactionKillLanded`
  // records which of the two happened, so the artifact never claims a kill the
  // run did not need.
  let compactionKillLanded = false;
  // The grant's kill outcome, recorded the same way. A grant that fires on the
  // launcher's final read fires after the child exited, so `reap()` returns
  // false; the budget block must say the ceiling was crossed at that read, not
  // claim a kill the run did not need.
  let grantKillLanded = false;
  // The work-checkpoint stepper (2026-11-08 rerun) is a small controller BESIDE
  // the token watchdog, sharing the same `usageWatch`. It is declared before the
  // token watchdog so the grant's callback can halt it.
  let policyWatch = null;
  const tokenWatchdog = createTokenWatchdog({
    grant: opts.tokenGrant,
    stopOnCompaction: opts.stopOnCompaction,
    watch: usageWatch,
    askSource: tokenAskSource,
    pollMs: TOKEN_POLL_MS,
    onGrant: () => {
      const landed = reap();
      grantKillLanded = landed;
      policyWatch?.stop();
      return landed;
    },
    // `reap` returns whether a live child was actually killed. It is recorded
    // rather than assumed: the mock-replay lane ends at the compaction on its
    // own, and a record that claimed "the tree was killed" for such a run would
    // be a false statement in the artifact.
    onCompaction: () => { compactionKillLanded = reap(); policyWatch?.stop(); },
  });
  const checkpointArmed = opts.stopAtCheckpoint !== null || opts.stopAfterCompactions !== null;
  if (checkpointArmed) {
    const checkpointFile = opts.stopAtCheckpoint === null
      ? null : resolve(workDir, opts.stopAtCheckpoint);
    policyWatch = createPolicyWatchdog({
      checkpointPath: opts.stopAtCheckpoint,
      checkpointFile,
      // A stop at 03 fires only when 00, 01, 02 and 03 all exist. A target not
      // in the derived list has no prefix and keeps the file-only rule.
      checkpointPrerequisites: checkpointFile === null
        ? null : checkpointPrerequisiteFiles({ paths: deliverables.paths, workDir, checkpointFile }),
      stopAfterCompactions: opts.stopAfterCompactions,
      watch: usageWatch,
      pollMs: TOKEN_POLL_MS,
      // A policy stop halts the grant poller first, so the grant cannot also
      // fire on the final read and relabel a checkpoint stop as a timeout.
      onCheckpoint: () => { tokenWatchdog.stop(); return reap(); },
      onCompactionLimit: () => { tokenWatchdog.stop(); return reap(); },
    });
  }
  process.on('SIGINT', () => {
    reap();
    policyWatch?.stop();
    tokenWatchdog.stop();
    usageWatch.close();
    tokenAskSource.close();
    mock?.kill();
    process.exit(130);
  });
  tokenWatchdog.start();
  policyWatch?.start();

  const exit = await childExit;
  if (watchdog !== null) clearTimeout(watchdog);
  policyWatch?.finalPoll();
  policyWatch?.stop();
  tokenWatchdog.stop();
  const policyState = policyWatch?.state ?? null;
  const stoppedAtCheckpoint = policyState?.checkpointFired === true;
  const stoppedAfterCompactions = policyState?.compactionLimitFired === true;
  const stoppedByPolicy = stoppedAtCheckpoint || stoppedAfterCompactions;
  // One last token poll unless a stop already fired: `observedPromptTokens` must
  // stay the number the kill was decided on (a later read would state a total
  // the fire never saw), while a run that ended below the grant still records
  // what it actually spent. A run whose last steps crossed the grant right at
  // exit fires here — the tree is already gone, so `reap` is a no-op, but the
  // spend is over budget and the record must say so. The compaction stop needs
  // the same last read for the same reason. A policy stop suppresses this read:
  // the run ended for the checkpoint, and a grant crossing at the same instant
  // must not relabel it. The post-run `usage` block still states the spend.
  if (!stoppedByPolicy && (opts.tokenGrant !== null || opts.stopOnCompaction)
    && !tokenWatchdog.state.tokenFired && tokenWatchdog.state.compactionFired !== true) {
    // The FINAL poll flushes a last line the writer left without a newline
    // (fifteenth audit item 3): the interval holds a partial line because the
    // child may still be writing, but a finished child's tail must be counted.
    tokenWatchdog.finalPoll();
  }
  usageWatch.close();
  tokenAskSource.close();
  const tokenWatch = tokenWatchdog.state;
  // The stop this run was launched for, or null. It is read from the watchdog's
  // own state (which the last poll above has just refreshed), never from the
  // compaction events the post-run reader parses: the watchdog is what decided
  // the kill, so a record built from anything else could disagree with it.
  const compactionStop = tokenWatch.compactionFired === true ? tokenWatch.compactionStoppedAt ?? {} : null;
  const stoppedOnCompaction = compactionStop !== null;
  // One run can carry one stop. A policy stop is read from its own controller;
  // the compaction landmark and the grant keep the fields they always had.
  const checkpointStop = stoppedAtCheckpoint ? policyState.checkpointStoppedAt ?? {} : null;
  const compactionLimitStop = stoppedAfterCompactions
    ? policyState.compactionLimitStoppedAt ?? {} : null;
  const stopReason = stoppedAtCheckpoint ? 'checkpoint'
    : stoppedAfterCompactions ? 'compactions'
      // A fired token grant is a budget stop, not a green run (2026-11-09 audit
      // item 1). The watchdog is what decided the kill, so it is read here with
      // the other stoppers and never inferred from the spend after the fact.
      : tokenWatch.tokenFired === true ? 'budget'
        : stoppedOnCompaction ? 'compaction' : null;
  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startedMs;

  writeFileSync(join(evidenceDir, 'stdout.ndjson'), Buffer.concat(stdoutChunks));
  writeFileSync(join(evidenceDir, 'stderr.log'), Buffer.concat(stderrChunks));
  if (mock !== null) {
    mock.kill();
    await mockExit;
    flushMockLogs();
  }

  // ── Collect ────────────────────────────────────────────────────────────────
  // One read per artifact, and the hash is taken from the bytes that read
  // returned (ISSUE-214 item 10): a second read could see a different file.
  const requestSnapshot = readJsonLinesSnapshot(requestLog);
  const requests = requestSnapshot.events;
  const requestLineGate = jsonLineGate([requestSnapshot], 'request log');
  const mains = requests.filter((entry) => entry.kind === 'main');
  const titles = requests.filter((entry) => entry.kind === 'title');
  // The host's own lanes, counted from the wire. They are only expected in
  // pressure mode, where the mock carries rows for them; a lane that appears
  // without a mode is evidence that something else asked.
  const compactionAsks = requests.filter((entry) => entry.kind === 'compaction');
  const postCompactionRequests = requests.filter((entry) => entry.kind === 'post-compaction');
  // The SAME discovery the in-run watchdog used, so the file the kill was
  // decided on is one of the files these totals are read from.
  const sessionFiles = findSessionLogs(sessionsDir);
  const sessionSnapshots = sessionFiles.map((file) => readJsonLinesSnapshot(file));
  const sessionEvents = sessionSnapshots.flatMap((snapshot) => snapshot.events);
  const sessionLineGate = jsonLineGate(sessionSnapshots, 'session log');
  // The context series and the compaction events: the two things pressure mode
  // exists to make measurable. The series is every conversation TURN the host
  // posted (record turns, then any post-compaction turn), never the title, prune
  // or summarization asks: those are the harness talking to itself, and folding
  // them in would make the peak describe a request no turn made. The selection
  // lives in `measurementSummary`, which states the byte series when a request
  // log exists and the session's billed-prompt series when it does not.

  const stdoutLines = Buffer.concat(stdoutChunks).toString('utf8').split(/\r?\n/u).filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: 'unparsed', line };
      }
    });
  const finalEvent = [...stdoutLines].reverse().find((event) => event.type === 'final');

  // Usage rows come from the shared parser (`session-usage.mjs`), the same one
  // `derive-run-b.mjs` and the in-run watchdog read: the post-run totals and the
  // grant-kill can never describe spend in different units. Coverage is read
  // beside it: every assistant turn must carry a row, or the watchdog saw less
  // spend than the run made (ISSUE-214 item 4).
  //
  // A resume round's usage block describes THE NEW LEG only. The adopted session
  // log still carries every prior assistant turn (and the prior leg's rows are
  // archived in `round-N/`), so summing the whole file would state a round-2
  // spend that includes round 1 — the same defect the ask lane had. The
  // boundary is `resumedFrom.priorSeq`, the last seq the adopted log carried
  // before this launch; the BENCH-DONE read below uses the same one.
  const usageEvents = resume === null
    ? sessionEvents
    : sessionEvents.filter((event) => Number(event?.seq) > resume.priorSeq);
  const usageRows = sessionUsageRows(usageEvents);
  const usageCoverage = usageCoverageOf(usageEvents, usageRows);
  const usage = {
    rows: usageRows,
    // The two counts item 4 asked for, beside the sums: `usageRows` is the
    // number of assistant turns that carried `data.usage`, `assistantTurns` is
    // the population, and `coverage` states whether they reconcile.
    usageRows: usageRows.length,
    assistantTurns: usageCoverage.assistantTurns,
    coverage: {
      missingRows: usageCoverage.missingRows,
      missingSeqs: usageCoverage.missingSeqs,
      // Fourteenth audit item 2: how many of those carried a usage object the
      // reader refused (no recognizable prompt-side token field). Stated apart
      // from a missing object so a renamed field is visible in the artifact.
      unrecognizedRows: usageCoverage.unrecognizedRows,
      unrecognizedSeqs: usageCoverage.unrecognizedSeqs,
      reconciled: usageCoverage.reconciled,
    },
    inputTokens: usageRows.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: usageRows.reduce((sum, row) => sum + row.outputTokens, 0),
    totalTokens: usageRows.reduce((sum, row) => sum + row.totalTokens, 0),
    // The derivation's billed-prompt sum: one component of the grant's true
    // total (main prompt + main output + ask prompt + ask output + the native
    // compaction call's prompt and output), so the grant can be checked against
    // what a finished run actually spent.
    billedPromptTokens: usageRows.reduce((sum, row) => sum + row.billedTokens, 0),
    cacheReadTokens: usageRows.reduce((sum, row) => sum + row.cacheReadTokens, 0),
    cacheWriteTokens: usageRows.reduce((sum, row) => sum + row.cacheWriteTokens, 0),
  };

  // ADR-0045's reasoning counts and gate, read from the same session events the
  // usage rows came from. `citableAs` is the run-level label: a void comparison
  // says so even when every assertion it could still make is green. The WIRE
  // reading is computed beside it (thirteenth audit item 2): only the mock's
  // request log holds request bodies, so a real route records `unmeasured` and
  // may not claim that reasoning was measured on the wire.
  // `usageEvents` is the resume-bounded population: on a resumed round the
  // adopted leg's reasoning rows are prior facts, archived in `round-N/`, not
  // this round's measurement.
  const reasoningCounts = reasoningCountsOf(usageEvents);
  const reasoningWire = reasoningWireOf(requests);
  const reasoningWireVerdict = reasoningWireGate({ provider: opts.provider, wire: reasoningWire });
  const reasoningVerdict = reasoningGate({
    provider: opts.provider,
    counts: reasoningCounts,
    allowZeroReasoning: opts.allowZeroReasoning,
    wire: reasoningWire,
  });

  // The two blocks `result.json` states for EVERY provider (ISSUE-214 item 2).
  // The byte series is used when a request log exists; a real route has none and
  // gets the session log's billed-prompt-token series instead. Neither is ever
  // `null`, and a compaction is recorded, never refused.
  // Same boundary for compaction: a `compaction/start` in the adopted leg must
  // not be counted as this round's compaction. The block still states the new
  // leg's row; the prior leg is visible in `resumedFrom` and `round-N/`.
  const summary = measurementSummary({ sessionEvents: usageEvents, requests, usageRows });
  const context = summary.context;
  const compaction = summary.compaction;

  // On a resume round only a marker written AFTER the boundary counts. The
  // adopted log still carries the previous round's BENCH-DONE, and finding it
  // first would let the old round's completion satisfy the new one. The seq is
  // the boundary the session had before this launch (`resumedFrom.priorSeq`).
  const doneEvent = sessionEvents.find((event) => event.type === 'assistant/message'
    && textOfEvent(event).includes('BENCH-DONE')
    && (resume === null || Number(event?.seq) > resume.priorSeq));
  const doneLine = doneEvent === undefined ? null
    : (textOfEvent(doneEvent).match(/BENCH-DONE[^\r\n]*/u) ?? [null])[0];

  // One row per tool/result: the tool it answers, whether it failed, and the
  // error code when one is recorded. `read`/`edit` failures are the ones a path
  // map is responsible for, so they are named rather than counted.
  const toolRows = sessionEvents
    .filter((event) => event.type === 'tool/result')
    .map((event) => {
      const message = event.data?.message ?? {};
      const error = event.data?.error ?? message.error ?? null;
      return {
        callId: String(message.source?.callId ?? message.toolCallId ?? ''),
        isError: message.isError === true,
        code: typeof error?.code === 'string' ? error.code
          : typeof error?.info?.code === 'string' ? error.info.code : null,
        text: textOfEvent(event).slice(0, 200),
      };
    });
  const callNameById = new Map(sessionEvents
    .filter((event) => event.type === 'tool/call')
    .map((event) => [String(event.data?.callId ?? ''), String(event.data?.name ?? '')]));
  const toolResultRows = toolRows.map((row) => ({ ...row, tool: callNameById.get(row.callId) ?? 'unknown' }));

  // ── Canonical projection (mock-replay determinism gate) ────────────────────
  // Built from script.json and the request/session records, never from raw
  // logs: the session log carries ids, seqs and absolute paths that move even
  // when nothing meaningful changed.
  const scriptSha256 = replay === null ? null : sha256File(scriptPath);
  // The served script, read back from the evidence dir: this is the spec the
  // fidelity gate holds the request stream against, and it is the file a
  // reviewer can open. The in-memory `replay.script` is not used for that
  // comparison, because comparing a value to itself is not a gate.
  const servedScript = replay === null ? null : JSON.parse(readFileSync(scriptPath, 'utf8'));
  const expectedFailures = replay === null ? null : expectedToolFailures(servedScript, opts.armDir);
  // Only the racoons arm can emit a journal; the vanilla arm must not have one.
  // The scan covers the evidence dir's top level and the wrapper's own
  // `<evidence>/racoons/`, so a mount that moved its output is found either way.
  // The parse perturbation writes a real bad line into the artifact BEFORE the
  // scan, so the gate meets the same thing a corrupt sink would leave behind.
  if (opts.perturbJournalParse) {
    const eventsPath = join(evidenceDir, CREMATOR_EVIDENCE_DIR, 'cremator-events.jsonl');
    if (existsSync(eventsPath)) {
      appendFileSync(eventsPath, '{"kind":"perturbed", this is not json}\n');
    }
  }
  // EVERY run scans the evidence dir, including the vanilla arm (fifteenth
  // audit item 1). The old condition scanned only a journal-gated racoons run,
  // so a vanilla live-route run left `journal === null` and every gate below was
  // skipped: the control proved no MOUNT (config) but not no REMOVALS
  // (evidence). The scan covers the evidence dir's top level and the mount's own
  // `<evidence>/racoons/`, and the ledger plan names the per-session durable
  // path even when no wrapper mounted, so a product artifact a vanilla run
  // should never carry is found by name and fails below.
  const journal = journalState(
    [evidenceDir, join(evidenceDir, CREMATOR_EVIDENCE_DIR)],
    ledgerPaths(join(evidenceDir, CREMATOR_EVIDENCE_DIR)));
  // The gates below hold the journal against the session log and the run's own
  // removal statement. On a resume both sides describe the NEW LEG: the usage
  // block is bounded at `priorSeq`, and this count starts at the journal's
  // launch byte boundary. The `journal` block above still describes the whole
  // adopted file, which is what the mount's record is; only the gates'
  // population is narrowed. The removal statement and the replacement
  // accounting read this same object, so a prior leg's applied rows can never
  // be reported as this round's removals (ISSUE-270).
  const journalNewLegCounts = resume === null || journal.journal === null
    ? journal.journal
    : journalCountsAfter(journal.journal.file,
      resumeAskOffsets.get(resolve(journal.journal.file)) ?? 0);
  // The perturbation the journal gates need: inflate the count the JOURNAL
  // states, leaving the file and the session log alone. A journal gate that stays
  // green with one more cap invented is reading nothing real, so a run carrying
  // this flag MUST fail by name. Since ISSUE-089 the gate it proves red is the
  // zero-caps invariant: ADR-0014 scrapped cap materialization, so the real value
  // is 0 and an invented 1 is a cap that no ruling allows. It edits this run's
  // in-memory counts only; the evidence on disk keeps what the mount wrote.
  if (journal !== null && journal.journal !== null && opts.perturbJournalCaps !== null) {
    journal.journal.capArchives += opts.perturbJournalCaps;
  }
  // The run-level removal statement (fifteenth audit item 2). Computed from the
  // journal BEFORE the result is assembled, so the PASS line, `result.json` and
  // `citableAs` can never describe a different number. On a resume this is the
  // NEW LEG's lane count, not the adopted journal's; `applied` is the product's
  // own lane count, and the ledger comparison is its own gate (item 6).
  const removals = removalSummary({ arm: opts.arm, journal: journalNewLegCounts });
  // The run-level citable label: a green run that applied NOTHING may not say
  // `measurement (product effect only)` as if the product effect was measured
  // (fifteenth audit item 2). A `none (…)` label keeps its own reason.
  const citableAs = removalCitable(reasoningVerdict.citableAs, removals);
  const projection = replay === null ? null : buildProjection({
    arm: opts.arm,
    provider: opts.provider,
    scriptSha256,
    mains,
    sessionEvents,
    toolResultRows,
  });
  const projectionText = projection === null ? null : `${JSON.stringify(projection, null, 2)}\n`;
  /** Diffs against a stored baseline; filled in only when --projection-in is set. */
  let projectionDiffs = null;
  let projectionSchemaError = null;
  if (projectionText !== null && opts.projectionIn !== null) {
    let stored = null;
    try {
      stored = JSON.parse(readFileSync(opts.projectionIn, 'utf8'));
    } catch (error) {
      projectionSchemaError = `the stored projection is not JSON: ${error.message}`;
    }
    if (projectionSchemaError === null && stored?.schema !== PROJECTION_SCHEMA) {
      projectionSchemaError = `the stored projection names schema ${JSON.stringify(stored?.schema)}, `
        + `this launcher writes ${PROJECTION_SCHEMA}`;
    }
    if (projectionSchemaError === null) projectionDiffs = diffProjection(stored, projection);
  }

  // The arm must be exactly the frozen image: in mock mode nothing may touch it.
  const treeAfter = opts.dryWork ? digestTree(opts.armDir) : null;
  const manifest = (() => {
    try {
      return JSON.parse(readFileSync(join(opts.armDir, 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
  })();
  const manifestDigest = manifest?.totals?.multisetSha256 ?? null;

  // The deny probe is a mock-smoke measurement: leg B needs a scripted
  // `subagent` call, and a replay record has none. Skipping it is a stated
  // outcome, never a partial pass, so the skip cannot turn a clean run red.
  const denySkipped = replay !== null;
  const probe = denyProbe(sessionEvents, opts.arm);
  const denyDoc = denySkipped
    ? [
      `arm=${opts.arm}`, 'DENY SKIPPED', `reason=${DENY_SKIP_REASON}`, '',
    ].join('\n')
    : probe.doc;
  writeFileSync(join(evidenceDir, 'deny-probe.txt'), denyDoc);
  const mockScript = opts.provider === 'mock' ? JSON.parse(readFileSync(opts.mockScript, 'utf8')) : null;
  const mockNeedle = typeof mockScript?.bench?.readNeedle === 'string' && mockScript.bench.readNeedle !== ''
    ? mockScript.bench.readNeedle : null;

  // ── Read boundary (ISSUE-039, ISSUE-235 item 5) ────────────────────────────
  // The arm's world is its tree (plus the `--dry-work` copy, which is a copy of
  // the tree). The evidence dir is the harness's own output and is NOT a world
  // root: when `--world` is used it sits INSIDE that world, so the classifier
  // takes it separately and a tool call naming it is an `evidence-path`
  // violation before containment can count it as `inside`. Everything else the
  // launcher can see inside the CAMPAIGN tree — the other arm's evidence,
  // `derive-*.json`, `build/`, `VERDICT.md` — is out of scope: a read of it
  // fails the run and names the call. A read outside the campaign is recorded
  // as evidence only; see `read-boundary.mjs` for why the campaign line is the
  // gate.
  const worldRoots = readWorldRoots({ world: opts.world, armDir: opts.armDir });
  const campaignRoot = campaignRootFor({
    worldRoot: opts.world, root: opts.root, armDir: opts.armDir, evidenceDir,
  });
  const readReport = workspaceOnlyReport(classifyToolCalls({
    sessionEvents,
    workDir,
    worldRoots: opts.dryWork ? [...worldRoots, workDir] : worldRoots,
    campaignRoot,
    evidenceDir,
    allow: [...opts.allowRead, ...opts.allowToolRoots],
    // Workspace-only means exactly that: the OS temp dir is not an extra
    // readable root. The default (undefined) keeps the temp exception for
    // every other run.
    scratch: opts.workspaceOnly ? [] : undefined,
  }), opts.workspaceOnly);
  const readBoundary = {
    world: opts.world,
    worldRoots,
    // Recorded apart from the roots: the harness's own output is not a readable
    // world root, and a tool call naming it is an `evidence-path` violation.
    evidenceDir,
    campaignRoot,
    workspaceOnly: opts.workspaceOnly,
    allowRead: opts.allowRead,
    allowToolRoots: opts.allowToolRoots,
    // The strict run's child env names this directory (TEMP/TMP/TMPDIR), and
    // it sits under a world root, so a path inside it is an `inside` row.
    ...(workspaceTemp === null ? {} : {
      tempDir: workspaceTemp.dir,
      tempEnv: workspaceTemp.env,
    }),
    inside: readReport.inside,
    // The number of paths the classifier actually judged. `inside: 0` beside a
    // `judged` of 0 means nothing was checked, not that every path was clean
    // (ISSUE-235 item 5); the note makes that empty set explicit in the record.
    judged: readReport.judged,
    ...(readReport.judged === 0 ? {
      judgedNote: 'no tool/call named a path the scan judges (absolute or parent-relative); '
        + 'inside: 0 means nothing was checked',
    } : {}),
    allowed: readReport.allowed,
    violations: readReport.violations,
    outside: readReport.outside.slice(0, 20),
    outsideCount: readReport.outside.length,
    // Recorded, not gated: a git read from a world with no `.git` below the
    // campaign root resolves UP into whatever repository encloses the campaign
    // (the 2026-10-28 vanilla arm's seq 1926 `git log`). The content is outside
    // the campaign, so the campaign line does not hold; the count is here so a
    // verdict can see the arm read outside its world.
    gitChannel: readReport.gitChannel.slice(0, 20),
    gitChannelCount: readReport.gitChannel.length,
    note: 'a path a tool/call named; paths built at runtime from shell variables are invisible to this scan; '
      + 'an allow-listed root is read-only; gitChannel counts git read calls that can resolve above the '
      + 'campaign root — recorded, never gated; evidenceDir is not a world root, so a call naming it is an '
      + 'evidence-path violation, never an inside read',
  };

  // The expected deliverable list was derived from the brief (or named by
  // --deliverables) before the run. One row per expected deliverable, in that
  // list's order, so k follows the brief rather than a fixed thirteen.
  const deliverableRows = deliverableRowsFor(deliverables.paths, workDir);
  const deliverablesCreated = deliverableRows.filter((row) => row.present).length;
  const largestCheckpointReached = deliverableRows.filter((row) => row.present)
    .reduce((max, row) => Math.max(max, row.k), 0);
  // The pair's comparable k is the contiguous prefix, not the highest present k:
  // a present 09 with 02 missing is not a k=10 reading.
  const largestCommonK = contiguousPrefixK(deliverableRows);

  // ── Assertions ─────────────────────────────────────────────────────────────
  const results = [];
  const check = (name, fn, options = {}) => {
    let outcome;
    try {
      outcome = fn();
    } catch (error) {
      outcome = error.message;
    }
    // `assertionRow` assigns the class: a plain `true` is a measured pass, a
    // returned `{ok, detail, class}` keeps its stated class (vacuous,
    // not-applicable, stopped-expected), and a red row is always `failed`
    // (thirteenth audit item 7).
    results.push(assertionRow(name, outcome, options));
  };

  // A stop at the first native compaction kills the child on purpose, so two
  // rows below cannot be scored the usual way and are replaced by one row that
  // checks the stop against the artifact instead. Nothing is silently skipped:
  // the rows a normal run carries (`exit code`, and the start/end pairing under
  // pressure) name expectations a killed child and a cut summarization cannot
  // meet, and a row claiming they did would be the vacuous pass the repo
  // forbids. `result.json.exit` still carries the child's own code, and
  // `stoppedOnCompaction` is what a reader keys on.
  if (compactionStop === null && !stoppedByPolicy) {
    check('exit code', () => (exit.code === opts.expectExit
      ? true : `expected exit ${opts.expectExit}, got ${String(exit.code)} (signal ${String(exit.signal)})`));
  } else if (stoppedAtCheckpoint) {
    // A checkpoint stop kills the child on purpose, so `exit code` cannot be
    // scored the usual way. This row is a cross-artifact check instead: the
    // file the stop fired on must still be in the arm after the run (the brief
    // forbids deletes). A missing file fails by name rather than being read as
    // a clean stop.
    check('the checkpoint stop names a file the arm still carries', () => (existsSync(checkpointStop.resolved)
      ? true : `the stop fired on ${checkpointStop.path} but ${checkpointStop.resolved} is absent after the run`));
  } else if (stoppedAfterCompactions) {
    // The stop was decided on the watchdog's own count; the post-run reader's
    // count must at least reach it. A session log that records fewer compactions
    // than the stop was decided on fails here, never reported as green.
    check('the compaction stop names compactions the session log records', () => (compaction.count >= compactionLimitStop.limit
      ? true : `the stop fired at ${String(compactionLimitStop.limit)} compaction(s) but the session log carries `
        + `${String(compaction.count)} compaction/start row(s)`));
  } else {
    // Not a green-by-construction row: the stop is decided by the watchdog and
    // this compares it to the session log the POST-RUN reader parsed, two
    // artifacts written by two code paths. A stop naming a compaction the log
    // does not carry (or one that is not the first) fails here by name.
    check('the stop names the first native compaction the session log records', () => {
      if (compaction.count < 1) {
        return `the watchdog stopped on compaction seq ${String(compactionStop.seq)} but the session log `
          + 'carries no compaction/start row';
      }
      if (compaction.count !== 1) {
        return `the stop should have ended the run at the first compaction, but the log carries `
          + `${String(compaction.count)} compaction/start rows`;
      }
      const firstSeq = compaction.atSeqs[0];
      if (firstSeq !== null && compactionStop.seq !== null && firstSeq !== compactionStop.seq) {
        return `the stop names seq ${String(compactionStop.seq)}, the log's first compaction/start is seq `
          + `${String(firstSeq)}`;
      }
      return true;
    });
  }
  // Only register the box's row when a box was ARMED. With `--kill-ms 0` no
  // timer exists, so a "did not fire" row would be true by construction and
  // count as evidence it cannot produce (law-verification-non-vacuity).
  if (opts.killMs > 0) {
    check('the kill box did not fire', () => (watchdogFired
      ? `the tree was killed after ${String(opts.killMs)} ms` : true));
  }
  // ISSUE-214 item 5: the grant's own row is registered ONLY when a grant
  // exists. The old unconditional `check` asserted a fact no launch could
  // falsify ("no grant was set, so no grant fired") and counted it as evidence.
  // Item 4 rides beside it: a grant whose every step did not carry a usage row
  // is a lower bound, so the run fails closed.
  for (const gate of tokenGrantGates({ tokenGrant: opts.tokenGrant,
    tokenWatch: { ...tokenWatch, killLanded: grantKillLanded }, usageCoverage })) {
    check(gate.name, () => (gate.ok
      ? (gate.detail === undefined ? true : { ok: true, detail: gate.detail })
      : gate.detail));
  }
  // ISSUE-214 item 3: a malformed line is a corrupt artifact, not a shorter
  // clean one. The old reader turned it into `{type:'unparsed'}` and no gate
  // ever looked. The detail names the 1-based line numbers. Fourteenth audit
  // item 5: no request log at all is `not-applicable` (the live route writes none), and
  // a present-but-empty log is `vacuous` — neither may count as a measured pass.
  check('request log: every line parses', () => (requestLineGate.ok
    ? { ok: true, class: requestLineGate.class ?? 'measured', detail: requestLineGate.detail }
    : requestLineGate.detail));
  check('session log: every line parses', () => (sessionLineGate.ok
    ? { ok: true, class: sessionLineGate.class ?? 'measured', detail: sessionLineGate.detail }
    : sessionLineGate.detail));
  check('session log exists', () => (sessionFiles.length > 0
    ? true : `no session.v4.jsonl under ${sessionsDir}`));
  check('exactly one session log', () => (sessionFiles.length === 1
    ? true : `expected 1 session.v4.jsonl, saw ${sessionFiles.length}`));
  // ADR-0045 (ISSUE-214 item 1): a measurement run must carry the agent's
  // reasoning. The detail is green on a covered run and names the counts and
  // the declared floor on a void or failed one. Fourteenth audit item 3: a void
  // comparison (`--allow-zero-reasoning`) is class `void`, so it is recorded
  // but never counted as a measured pass. The gate is not-applicable on the two
  // mock lanes, so the row states that class instead of a green measurement.
  check('reasoning: the session carries the agent\'s reasoning (ADR-0045)', () => ({
    ok: reasoningVerdict.ok,
    class: !reasoningVerdict.applicable ? 'not-applicable'
      : reasoningVerdict.voided ? 'void' : 'measured',
    detail: reasoningVerdict.detail,
  }));
  // Thirteenth audit item 2: the session log is not the wire. A run whose
  // request bodies were captured must show reasoning_content in at least one
  // main request; a run with no captured body records `unmeasured` and the row
  // is not-applicable, never a wire-level pass.
  if (reasoningWireVerdict.applicable) {
    check('reasoning: at least one measured main request carries reasoning_content', () => ({
      ok: reasoningWireVerdict.ok,
      class: reasoningWireVerdict.class,
      detail: reasoningWireVerdict.detail,
    }));
  }
  // ISSUE-214 item 4: every assistant turn must carry a usage row, and the two
  // counts must reconcile. A missing row is a step whose spend the watchdog
  // could not see. Fourteenth audit item 5: 0 turns and 0 rows is an empty
  // subject — `not-applicable`, never a measured 0/0 pass. An unrecognized row
  // is named separately and is red.
  check('usage: every assistant turn carries a usage row', () => {
    if (usageCoverage.assistantTurns === 0 && usageCoverage.usageRows === 0) {
      return { ok: true, class: 'not-applicable',
        detail: 'no assistant turn was recorded, so no usage row was owed; the usage lane was not exercised' };
    }
    return usageCoverage.reconciled
      ? { ok: true, detail: `${String(usageCoverage.usageRows)} usage row(s) for `
        + `${String(usageCoverage.assistantTurns)} assistant turn(s)` }
      : `${String(usageCoverage.missingRows)} assistant turn(s) carried no billable usage row `
        + `(seq ${usageCoverage.missingSeqs.join(', ')}`
        + `${usageCoverage.unrecognizedRows > 0
          ? `; ${String(usageCoverage.unrecognizedRows)} carried a usage object with no recognizable prompt token field`
          : ''}); the totals and the token grant are lower bounds`;
  });
  // ── Native compaction closure, on EVERY provider (fifteenth audit item 4) ──
  // The opened/closed pairing used to be registered inside the replay block,
  // so a live run that opened a compaction and never closed it was
  // green. The session log is read on every provider, so the gate runs on every
  // provider: a start with no end is a failed condensation, and the only
  // intended exception is the stop this run was launched for (`stopped-expected`).
  check('compaction: every compaction the host opened closed', () => {
    // A compaction-limit stop can cut the Nth summarization the same way the
    // first-compaction stop cuts its own; both are the instrument working.
    const gate = compactionClosedGate({ compaction, stoppedOnCompaction: stoppedOnCompaction || stoppedAfterCompactions });
    return gate.ok ? { ok: true, class: gate.class, detail: gate.detail } : gate.detail;
  });
  // ── The host's competing pruner (ADR-0041; arm rule 2026-11-09) ────────────
  // The expected state is the ARM's: `racoons` disables the host pruner (the
  // mount is the only remover), `vanilla` leaves the host at its default (on).
  // Two artifact claims follow. First, the COMPOSED config must match that
  // state: every copy disabled for racoons, no copy disabled for vanilla.
  // Second, a `compaction/prune` event is the pruner actually trimming. On the
  // racoons arm that is a second mechanism and fails; on the vanilla arm it is
  // the control's own work and is accounted by the replacement gate. The
  // zero-events gate is registered only for `disabled`: on `host-default` a
  // check that returned true would be the vacuous green the law forbids.
  check('host pruner: the composed config matches the arm\'s state', () => {
    if (isolation === null) return 'no composed config was taken for this run';
    if (prunerState === HOST_PRUNER_DISABLED) {
      return isolation.applied ? true
        : `the composed config does not disable ${HOST_PRUNER_ID}: ${String(isolation.error)}`;
    }
    return isolation.rows > 0 && isolation.disabledRows === 0 ? true
      : `the ${opts.arm} arm runs ${prunerState} but the composed config has ${String(isolation.disabledRows)}/`
        + `${String(isolation.rows)} ${HOST_PRUNER_ID} row(s) disabled`;
  });
  if (prunerState === HOST_PRUNER_DISABLED) {
    // The name states its population: the rows this launcher READ. "The session
    // log carries zero events" was a negative over an absence — a run with no
    // session log passed it green while failing the presence gate elsewhere.
    check('host pruner: no compaction/prune event is among the session rows read', () => (
      compaction.pruneEvents === 0 ? true
        : `the ${String(sessionEvents.length)} session row(s) read carry `
          + `${String(compaction.pruneEvents)} compaction/prune event(s); `
          + 'the host pruner is disabled for the racoons arm (ADR-0041), so this run measured two mechanisms'
    ));
  }
  if (opts.provider === 'mock') {
    check('mock has no unmatched requests', () => {
      const missed = requests.filter((entry) => entry.matched === 'no-match' || entry.matched === 'auth-mismatch' || entry.matched === 'unrouted');
      return missed.length === 0 ? true : `${missed.length} request(s) went unmatched, first: ${JSON.stringify(missed[0]).slice(0, 300)}`;
    });
    check('mock answered every scripted turn', () => {
      const want = Array.isArray(mockScript?.replies) ? mockScript.replies.length : -1;
      return mains.length === want ? true : `expected ${want} main request(s), saw ${mains.length}`;
    });
    check('the mock saw only the dummy key', () => (requests.length > 0
      && requests.every((entry) => entry.headers_redacted?.['x-api-key'] === '<dummy>')
      ? true : 'a request did not present the bench dummy key'));
    check('title requests stay within 0..1', () => (titles.length <= 1 ? true : `saw ${titles.length} title request(s)`));
  }
  // The replay's consumption record, written inside the `replay !== null` block
  // below but read by `result.json` outside it.
  let replayPrefix = null;
  let compactionCut = false;
  if (replay !== null) {
    // `no-match` is the loudest signal this mode has: it means the live host
    // sent a request key the record did not have, i.e. the replay diverged.
    check('replay: no request went unmatched', () => {
      const missed = requests.filter((entry) => entry.matched === 'no-match' || entry.matched === 'auth-mismatch' || entry.matched === 'unrouted');
      return missed.length === 0 ? true : `${missed.length} request(s) went unmatched, first: ${JSON.stringify(missed[0]).slice(0, 300)}`;
    });
    // The record's own rows only. The prune rows a racoons script carries are
    // replay-external (a queue of identical forgetall matchers for the mount's
    // asks), so demanding they be consumed would fail on every unused row;
    // `mainReplies` is this gate's counterpart to the rig's `mainRequests`.
    //
    // The claim is a PREFIX, never "every reply": once the host condenses the
    // conversation, the recorded key sequence no longer exists (the checkpoint
    // replaces a span and the tool-result count drops), so the replay genuinely
    // stops there. The old green line said `every scripted reply was consumed`
    // on such a cut, which was false (ISSUE-214 item 7). The strict claim —
    // consumed rows match the script row for row — still holds for every
    // completed request, so a skip, repeat or reorder still fails by request
    // number, and the detail stays on the green row.
    compactionCut = compaction.count > 0;
    const replayWanted = mainReplies(servedScript).map((entry) => entry.name);
    const replaySeen = mains.map((entry) => entry.matched);
    replayPrefix = consumedPrefixOf({
      wanted: replayWanted,
      seen: replaySeen,
      cutByCompaction: compactionCut,
    });
    check(`replay: consumed prefix ${String(replayPrefix.consumed)} of `
      + `${String(replayPrefix.scripted)} scripted replies`, () => (replayPrefix.ok
      ? { ok: true, detail: replayPrefix.detail }
      : replayPrefix.detail));
    // The table lane on the wire: the mount's asks reached the mock and every
    // one was answered by a prune row. The racoons arm is the only arm with a
    // mount, so it is the only arm that may ask; a vanilla run that starts
    // asking means a mount leaked into it. Counts are evidence, never a target.
    // Since ADR-0028 the bulk prune is the ONE table asker, so there is no
    // second lane to route between and no row-count test: any table ask is the
    // prune lane, whatever its row count.
    check(`replay: the ${opts.arm} arm's table asks are answered`, () => tableAskOutcome({
      arm: opts.arm,
      asks: requests.filter((entry) => entry.kind === 'prune'),
    }));
    // Matcher keys as the mock saw them: the pair the converter keys on. The
    // expected side is `<evidence>/script.json` READ BACK FROM DISK, not the
    // in-memory copy the mock was handed: the served artifact is the spec, and
    // a gate that compares the live script to itself would be true by
    // construction. `--perturb-swap-match` edits the served copy, so a broken
    // script fails here by request number and key.
    check('fidelity: request keys match the served script per turn', () => {
      const observed = requestKeys(mains);
      // Main rows only: a prune row answers the fork's table ask, which ends
      // with the table final line and is outside the record's request-key
      // sequence.
      const expected = scriptKeys(mainReplies(servedScript));
      // A host compaction ends the replay: the requests that DID run must still
      // match their rows key for key, so a divergence before the cut is named
      // exactly as before. A cut without a compaction is a real divergence.
      if (observed.length > expected.length) {
        return `expected ${expected.length} main request(s), saw ${observed.length}`;
      }
      if (observed.length < expected.length && !compactionCut) {
        return `expected ${expected.length} main request(s), saw ${observed.length}`;
      }
      for (let i = 0; i < expected.length; i += 1) {
        if (observed[i] === undefined) break;
        if (observed[i].tool_results_count !== expected[i].tool_results_count) {
          return `request ${i + 1} (${expected[i].name}): expected tool_results_count `
            + `${expected[i].tool_results_count}, saw ${observed[i].tool_results_count}`;
        }
        if (JSON.stringify(observed[i].last_assistant_tool_names) !== JSON.stringify(expected[i].last_assistant_tool_names)) {
          return `request ${i + 1} (${expected[i].name}): expected last_assistant_tool_names `
            + `${JSON.stringify(expected[i].last_assistant_tool_names)}, saw ${JSON.stringify(observed[i].last_assistant_tool_names)}`;
        }
      }
      return true;
    });
    check('the mock saw only the dummy key', () => (requests.length > 0
      && requests.every((entry) => entry.headers_redacted?.['x-api-key'] === '<dummy>')
      ? true : 'a request did not present the bench dummy key'));
    check('title requests stay within 0..1', () => (titles.length <= 1 ? true : `saw ${titles.length} title request(s)`));
    // The path map's whole point: a rewritten `read` must not fail. A failed
    // result still advances `tool_results_count`, so without this the run stays
    // green while replaying errors (ISSUE-023 §2). A failed `edit` is a
    // different animal: its `old_string` is recorded prose from another
    // repository and no path map can make it match, so those failures are
    // counted and named, never hidden, and the assertion is on the path class.
    check('replay: no tool result failed on a path', () => {
      const pathFailures = toolResultRows.filter((row) => row.code === 'FS_NOT_FOUND' || row.code === 'FS_NOT_REGULAR_FILE');
      return pathFailures.length === 0 ? true
        : `${pathFailures.length} result(s) failed on a path, first: ${pathFailures[0].tool} ${pathFailures[0].text}`;
    });
    check('replay: every read succeeded', () => {
      const bad = toolResultRows.filter((row) => row.tool === 'read' && row.isError);
      return bad.length === 0 ? true : `${bad.length} read result(s) failed, first: ${bad[0].code ?? 'no code'} ${bad[0].text}`;
    });
    check('replay: the mocked call order matches the script', () => {
      const wanted = replay.script.replies.flatMap((entry) => (Array.isArray(entry.reply.calls) ? entry.reply.calls.map((call) => call.name) : []));
      const seen = sessionEvents.filter((event) => event.type === 'tool/call').map((event) => String(event.data?.name));
      // A host compaction cuts the record, so the calls that ran are a PREFIX of
      // the scripted sequence; anything else (a reorder, a skip, an extra call)
      // is still a defect and is named with both counts.
      const cutShort = compactionCut && seen.length <= wanted.length
        && seen.every((name, index) => name === wanted[index]);
      if (cutShort) return true;
      return JSON.stringify(seen) === JSON.stringify(wanted) ? true
        : `expected ${wanted.length} call(s) ${JSON.stringify(wanted)}, saw ${seen.length} ${JSON.stringify(seen)}`;
    });
    // Fidelity: the failures the SCRIPTED calls must produce, derived from the
    // served script and the arm's bytes. A replayed `edit` carries foreign
    // prose, so `FS_EDIT_NOT_FOUND` is expected; anything else is a real defect
    // and fails here by tool and code. The projection carries the same multiset,
    // so a baseline that silently lost or gained a failure also shows.
    check('fidelity: tool failures are exactly the scripted constant', () => {
      // Under pressure a host compaction can cut the record, so the expected
      // multiset is the one the calls that ACTUALLY RAN must produce. The
      // simulation is over the same served script either way; the bound is how
      // many scripted calls the session log saw, so a cut run is not asked to
      // produce the failures of turns it never reached.
      const callsRun = sessionEvents.filter((event) => event.type === 'tool/call').length;
      const expected = compactionCut
        ? expectedToolFailures(prefixScript(servedScript, callsRun), opts.armDir)
        : expectedFailures;
      const observed = projection?.tool_failures ?? { count: -1, by_code: {}, by_tool: {} };
      const unexpected = toolResultRows.find((row) => row.isError
        && expected.detail.every((entry) => entry.tool !== row.tool || entry.code !== (row.code ?? 'no-code')));
      return toolFailureOutcome({
        observed,
        expected,
        firstUnexpected: unexpected === undefined
          ? null : `${unexpected.tool} ${unexpected.code ?? 'no code'} ${unexpected.text}`,
      });
    });
    // ── Synthetic pressure (only when --inflate-bytes is set) ────────────────
    // The mode's own gates. They assert AGREEMENT and COVERAGE, never a count:
    // a record that never reaches the trigger is a measurement, not a failure,
    // and a run that compacts when the arithmetic says it should is evidence.
    if (opts.inflateBytes !== null) {
      // The filler must have been attached to every scripted shell call: a
      // partial application would leave some results small and make the peak
      // describe a script that was only half inflated.
      check('pressure: every scripted shell call was padded', () => {
        const padded = replay.inflation?.results ?? 0;
        const shellCalls = replay.script.replies
          .flatMap((entry) => (Array.isArray(entry.reply.calls) ? entry.reply.calls : []))
          .filter((call) => SHELL_TOOLS.has(call.name)).length;
        if (padded === 0) return 'no scripted shell call was padded; the flag reached no reply';
        return padded === shellCalls ? true
          : `${String(padded)} of ${String(shellCalls)} scripted shell call(s) were padded`;
      });
      // The filler must be PRESENT in what the model saw. This is a presence
      // check, not a size check: `minBytes` is a request to the scripted
      // command, and the host's own caps (spill-policy 12,500 tokens; the read
      // tool's 50 KiB) clip it, so a delivered result smaller than `minBytes`
      // is the cap doing its job, not a failure. What must never happen is a
      // result that carries no filler at all, which would mean the flag reached
      // no reply and the run measures nothing.
      check('pressure: the filler is present in the delivered results', () => {
        const delivered = deliveredResultBytes(sessionEvents);
        if (delivered.count === 0) return 'no tool/result row in the session log';
        if (delivered.max < FILLER_MIN_LINE) {
          return `the largest delivered result is ${String(delivered.max)} B; the filler never reached the model`;
        }
        return true;
      });
      // The host pruner claim is NOT asserted here: since ADR-0041 it belongs to
      // every run, not to this mode, so its gates live with the universal
      // post-run assertions above ("host pruner: ..."). Asserting it here too
      // would judge the same dump twice and let one copy go green while the
      // other is red.
    }
    // ── Context pressure and host compaction, judged on every replay ─────────
    // These four gates are NOT synthetic-pressure-only: a long real record
    // reaches the trigger by its own content, and when it does the host's
    // compaction lane and the prefix cut must be judged exactly as a padded run
    // is. The flag decides how pressure was made, never whether pressure counts.
    {
      // The context series must describe the turns that ran. Zeros mean the
      // request log was never read, which is the failure a peak of 0 hides; a
      // series SHORT of the session log's assistant turns means the artifact
      // lost part of the conversation (thirteenth audit item 5).
      check('pressure: the context series has one entry per conversation turn', () => (
        contextSeriesCoverage({
          series: context.series,
          assistantTurns: reasoningCounts.assistantTurns,
          peakRequest: context.peakRequest,
        })
      ));
      // Compaction, as the session log states it. Every branch below reads the
      // recorded EVENT COUNT (`compaction/start`, `compaction/end`) and the
      // context series; none does token arithmetic. The bench cannot recompute
      // the host's token meter from raw request bytes (it prices blocks, framing
      // and the routed model's own baseline, so bytes/4 understates it and a
      // threshold built from it would false-fail a healthy arm). What it CAN
      // check is that a compaction which opened also closed, that it fired
      // before the conversation ended, and that the context the model saw
      // afterwards is smaller — a compaction that changes nothing is the
      // failure these gates exist to catch.
      //
      // Zero compactions is `vacuous`, and a --stop-on-compaction 1-start/0-end
      // pairing is `stopped-expected`: both are recorded, neither counts as a
      // measured pass (thirteenth audit items 6 and 7). The run's exit code is
      // unchanged by the classification: a stop still exits 1.
      check('pressure: compaction agrees with the recorded pressure', () => (
        compactionAgreementGate({ compaction, context, stoppedOnCompaction: stoppedOnCompaction || stoppedAfterCompactions })
      ));
      // The closure row moved out of this block (fifteenth audit item 4): it is
      // registered for every provider above. What stays here is the request
      // lane, which only a replay has.
      // The summarization ask and the post-compaction turn are the host's own
      // requests; each must be answered by its own lane, never by a record row.
      // Fourteenth audit item 5: a replay with no compaction request made no
      // subject for this row, so it is `not-applicable` — not a measured pass at
      // 0 wrong of 0.
      check('pressure: the host compaction lane is answered, not replayed',
        () => hostCompactionLaneOutcome(requests));
    }
    // The determinism gate. The expected side is a file written by an EARLIER
    // run (or hand-edited), so it cannot be this run's own value: a projection
    // that moved fails here, and the failure names every drifted key. The check
    // exists only when a baseline was passed; a check that returns true because
    // no baseline was given is the vacuous green the law forbids.
    if (opts.projectionIn !== null) {
      check('canonical projection matches the stored baseline', () => {
        if (projectionSchemaError !== null) return projectionSchemaError;
        if (projectionDiffs === null) return 'no projection was built; --projection-in needs a mock-replay run';
        if (projectionDiffs.length === 0) return true;
        const lines = projectionDiffs.map((diff) => `  ${diff.path}: expected ${JSON.stringify(diff.expected)}, actual ${JSON.stringify(diff.actual)}`);
        return `projection differs in ${String(projectionDiffs.length)} key(s) `
          + `(baseline ${opts.projectionIn}):\n${lines.join('\n')}`;
      });
    }
  }
  // ── The mount-side evidence, on EVERY run ──────────────────────────────────
  // The projection cannot carry these, and since ISSUE-082 the real-API route
  // is gated too: the live route mounts the same wrapper, so a missing journal is a
  // failed assertion there exactly as it is on a replay. Pointing
  // `--plugin-entry` at the shipped entry removes the sink (the perturbation)
  // and leaves the gate armed, so the run fails BY NAME. The vanilla arm must
  // emit neither file, and the scan that decides that runs on every run
  // (fifteenth audit item 1), so the control is evidence, not just config.
  if (journal !== null) {
    check(`fidelity: the ${opts.arm} arm's journal is present and parsed`, () => {
      if (opts.arm === 'racoons') {
        // A mock (non-replay) racoons run mounts the shipped entry, which has
        // no sink: no journal is expected, and the row states that rather than
        // failing a run the route was never gated for.
        if (!journalGated) {
          return { ok: true, class: 'not-applicable',
            detail: 'the mock lane mounts the shipped entry, which has no journal sink; no journal is expected' };
        }
        if (!journal.emitted) {
          return `no cremator-events.jsonl under ${evidenceDir}/racoons; the mount supplied no sink `
            + '(a --plugin-entry naming the shipped entry does this on purpose)';
        }
        if (journal.unparsable.length > 0) {
          return `${journal.unparsable.length} journal line(s) are not JSON, first: ${journal.unparsable[0].line}`;
        }
        return journal.journal.lines > 0 ? true : `${journal.journal.file} is empty`;
      }
      // The vanilla arm must carry NO product artifact (fifteenth audit item 1),
      // found by the scan every run now performs. A journal or a ledger — the
      // durable per-session path included — is named, never green silence.
      const gate = vanillaEvidenceGate(journal);
      return gate.ok ? { ok: true, class: gate.class, detail: gate.detail } : gate.detail;
    });
    // The journal-to-session usage gate (2026-11-09 audit item 5b). The journal
    // and the session log are written by two code paths, so agreement that every
    // assistant turn has one journal usage row and that the reconciled input sum
    // equals the session's billed prompt is evidence, not a value compared with
    // itself. A mismatch is a named failure; a run with no usage subject is
    // `not-applicable` and never a measured pass.
    check('usage: the journal\'s usage rows reconcile to the session totals', () => {
      if (opts.arm !== 'racoons' || !journalGated) {
        return { ok: true, class: 'not-applicable',
          detail: opts.arm === 'vanilla'
            ? 'the vanilla arm writes no journal, so there is no journal usage lane to compare'
            : 'the mock lane mounts the shipped entry, which journals no usage row' };
      }
      const gate = journalUsageGate({
        // On a resume this is the new leg's journal rows, the same population
        // `usage` states; a non-resume run reads the whole file, unchanged.
        counts: journalNewLegCounts,
        assistantTurns: usage.assistantTurns,
        billedPromptTokens: usage.billedPromptTokens,
      });
      return gate.ok ? { ok: true, class: gate.class, detail: gate.detail } : gate.detail;
    });
    // The mount-only line: `mounted` names the storage root the mount actually
    // opened, which only the mount writes. A stub with plausible `entry-ask-*`
    // lines cannot satisfy it, so the gate above cannot be met by prose.
    check(`fidelity: the ${opts.arm} arm's journal carries the mount's own mounted line`, () => {
      if (opts.arm !== 'racoons') return true;
      if (!journalGated) {
        return { ok: true, class: 'not-applicable',
          detail: 'the mock lane mounts the shipped entry, which writes no mounted line' };
      }
      const gate = mountedLineGate(journal, mountHarness === null ? null : mountHarness.storageRoot);
      return gate.ok ? true : gate.detail;
    });
    // The ledger side: the durable record must exist, open read-only, hold
    // every recall id the journal says the mount published, AND the bytes behind
    // each one must be in the blob store behind the hashes the ledger states
    // (fourteenth audit item 4). The expected side is the journal line; the
    // actual side is the closed sqlite file and its blobs, read in this process
    // — two artifacts written by two code paths (the port's publish callback and
    // the engine's ledger commit), so agreement is evidence and not a comparison
    // of a value to itself. Thirteenth audit item 3: an empty recall set is NOT
    // a green row — applied removals with no published recall fail, and zero
    // removals records `not-applicable`.
    check(`fidelity: the ${opts.arm} arm's ledger holds every published recall`, () => {
      if (opts.arm !== 'racoons') {
        // The durable per-session path is checked too: a mount that wrote only
        // its ledger under `<evidence>/racoons/storage/sessions/<id>/` would
        // otherwise evade a one-level scan.
        const found = journal.files.some((file) => file.kind === 'ledger')
          || journal.ledger.present === true;
        return found ? 'the vanilla arm emitted a racoons ledger' : true;
      }
      if (!journalGated) {
        return { ok: true, class: 'not-applicable',
          detail: 'the mock lane mounts the shipped entry, which opens no racoons ledger' };
      }
      if (!journal.ledger.present) {
        const primary = journal.ledger.primary ?? '<per-session path unknown>';
        const legacy = journal.ledger.legacy ?? '<legacy path unknown>';
        return `no ledger at the per-session durable path ${primary} `
          + `(storage root ${String(journal.ledger.storageRoot ?? '<unknown>')}); `
          + `the deprecated host-injected path ${legacy} is absent too`;
      }
      if (!journal.ledger.readable) return `the ledger is unreadable: ${String(journal.ledger.error)}`;
      const counts = journal.journal ?? {};
      return recallLedgerGate({
        recallIds: counts.recallIds ?? [],
        // The same three applied lanes the replacement accounting uses: a
        // removal is one the host spliced out, and each one owes a recall path.
        removals: Number(counts.appliedRemovals ?? 0)
          + Number(counts.landedEntries ?? 0)
          + Number(counts.appliedForgets ?? 0),
        ledgerRecallIds: journal.ledger.recallIds ?? [],
        recallParts: journal.ledger.recallParts ?? null,
        blobRoot: journal.ledger.blobRoot ?? null,
      });
    });
    // The zero-caps invariant. ADR-0014 (2026-10-23) scrapped cap
    // materialization: the core renderer refuses a `cap` operation, so no
    // `publish` line may carry an archive with `operationKind: 'cap'`. This is
    // an invariant, not a count against a target — the value is 0 by ruling on
    // every artifact, and any other value means a mechanism that was removed
    // has come back. `--perturb-journal-caps` shifts this count in memory,
    // which is the red proof that this gate reads the journal it names. With no
    // archive published at all the gate returns `not-applicable` (fourteenth
    // audit item 5), and the row keeps that class.
    check(CAP_ARCHIVE_GATE, () => {
      if (opts.arm !== 'racoons') {
        return { ok: true, class: 'not-applicable',
          detail: 'the vanilla arm publishes no archives; the zero-caps invariant does not apply' };
      }
      if (!journalGated) {
        return { ok: true, class: 'not-applicable',
          detail: 'the mock lane mounts the shipped entry, which publishes no archive to the bench' };
      }
      // A racoons arm with no journal is already red on the presence gate
      // above; naming it here too keeps this one from reading green by silence.
      if (journal.journal === null) return 'no journal to read the archives from';
      const gate = capArchiveGate(journal.journal);
      return gate.ok ? { ok: true, class: gate.class, detail: gate.detail } : gate.detail;
    });
    // The like-for-like accounting that replaced the cap count: every
    // `tool/result` replacement the host stored is one removal the mount
    // applied. Four lanes account for all of them (see `journal-fidelity.mjs`
    // for the citation for each): applied prune removals, landed entry shapes,
    // applied manual forgets, and the host pruner's trims when it was left
    // mounted. A keep-all's `user/message` rewind is a different lane — a host
    // exchange splice with no removal behind it — and is excluded, which is
    // what the recorded keep-all artifact requires (1 such replace, 0 removals).
    // 0 == 0 is an empty subject and the row says so (fourteenth audit item 5).
    check(replacementGateName(opts.arm), () => {
      if (opts.arm === 'racoons' && !journalGated) {
        return { ok: true, class: 'not-applicable',
          detail: 'the mock lane mounts the shipped entry, which records no applied lane to compare' };
      }
      // The host's own tool-result pruner is mounted only when the composed
      // config leaves a copy of its row enabled — which is the vanilla arm's
      // state by default, and the racoons arm's only when it took the opt-out.
      // The session log states how many trims it made (`compaction/prune`), so
      // the check is still a comparison of two artifacts, not a waiver.
      const hostPruned = hostPrunerTrims({
        pruneEvents: compaction.pruneEvents,
        isolation,
        allowHostPruner: opts.allowHostPruner,
      });
      // A DISABLED state's only legitimate replacement count is zero: the
      // control must not hide a product replace behind a host trim (fifteenth
      // audit item 1). A `host-default` run — the vanilla control, or a racoons
      // opt-out — has the host mechanism on by design; its trims are accounted
      // as the host pruner's lane rather than dumped on the product.
      // The replacement scan is the resume-bounded population: a prior leg's
      // stored `surfaceOp: replace` rows are archived with it, never counted as
      // this round's removals.
      const gate = replacementAccounting({ arm: opts.arm,
        hostPruned: prunerState === HOST_PRUNER_DISABLED ? 0 : hostPruned,
        sessionEvents: usageEvents, journal: journalNewLegCounts });
      return gate.ok ? { ok: true, class: gate.class, detail: gate.detail } : gate.detail;
    });
    // The removal count is journal-derived; this row is the LEDGER side of the
    // same claim (fifteenth audit item 6). The ledger's `application_removals`
    // table is written at prepare time, so only rows whose intent has an
    // `applied` event are removals the host spliced out; the count must equal
    // the journal's applied lanes, and every applied recall id must be in the
    // `recalls` table (or the removal has no restore path). The two artifacts
    // are written by two code paths, so agreement is evidence.
    check(REMOVAL_LEDGER_GATE, () => {
      if (opts.arm !== 'racoons' || !journalGated) {
        return { ok: true, class: 'not-applicable',
          detail: opts.arm === 'vanilla'
            ? 'the vanilla arm applies no removal; there is no applied lane to compare with a ledger'
            : 'the mock lane mounts the shipped entry, which opens no racoons ledger' };
      }
      const ledger = journal.ledger;
      const gate = removalLedgerGate({
        journal: journal.journal,
        // An absent ledger cannot state applied rows; the recall gate above
        // already names the absence, and this row fails closed with it.
        applied: ledger.present && ledger.readable ? ledger.appliedRemovals ?? null : null,
        ledgerRecallIds: ledger.present && ledger.readable ? ledger.recallIds ?? null : null,
        ledgerReadable: ledger.present && ledger.readable,
      });
      return gate.ok ? { ok: true, class: gate.class, detail: gate.detail } : gate.detail;
    });
  }
  if (realApi) {
    check('the launcher exported no API key', () => (childEnv.DEEPSEEK_API_KEY === undefined
      ? true : 'the child environment carried a key'));
    // One usage row is one row: it says the session log recorded provider usage,
    // not that an answer was billed. The name states the reading, not a claim
    // about billing that one row cannot carry.
    check('the session log carries at least one provider usage row', () => (usageRows.length >= 1
      ? true : 'no assistant/message row carried data.usage; the session log recorded no provider usage'));
    // Field-scoped on purpose (ISSUE-078, 2026-10-28): only request-shaped
    // records are read, and inside them only string values at endpoint keys
    // (`url`, `baseUrl`, `host`, …, the adapter config object included). A
    // `tool/result` that quotes a document mentioning localhost is content,
    // not routing — the old whole-record `JSON.stringify(event).includes(…)`
    // failed the extended run on exactly that. `loopback-gate.mjs` carries the
    // full rationale; hits are deduplicated by callId so the message names
    // distinct calls. Fourteenth audit item 5: a record set with no
    // request-shaped row is an empty subject and the row is `not-applicable`.
    check(LOOPBACK_GATE, () => {
      const gate = loopbackGate({ stdoutLines, sessionEvents });
      if (!gate.ok) return gate.detail;
      return { ok: true, class: gate.class ?? 'measured', detail: gate.detail };
    });
  }
  // A completed real-route run requires BENCH-DONE whether or not
  // `--require-done` was named: an exit 0 without the marker is a finished
  // process, not a finished task. A stop (budget/compaction/checkpoint) is a
  // censored partial already and its own record says so.
  const doneRequirement = benchDoneRequirement({
    provider: opts.provider,
    requireDone: opts.requireDone,
    stopReason,
    doneFound: doneEvent !== undefined,
  });
  if (doneRequirement.required) {
    check('BENCH-DONE was declared', () => (doneRequirement.ok ? true : doneRequirement.detail));
  }
  // The done gate reads the work copy, not the final text: a run can print
  // BENCH-DONE without writing the records. It is registered only for a
  // completed run that declared done and whose brief named its deliverables; a
  // censored partial reports its reached count in `stop`, and a smoke/replay
  // task that names no deliverables has no list to gate on.
  if (stopReason === null && resume === null && doneEvent !== undefined && deliverables.declared) {
    const gate = deliverableGate({
      rows: deliverableRows,
      expected: deliverables.paths.length,
      label: deliverables.source === 'brief' ? 'brief' : 'expected',
    });
    check(gate.name, () => (gate.ok ? true : gate.detail));
  }
  // A resume round is judged by what it ADDED. The baseline was read before the
  // launch, so a file a previous round wrote can never satisfy this row, and a
  // round that wrote nothing is red even if every expected file already exists.
  // A task file that names no explicit list has nothing to owe: the row is
  // not-applicable, and the default thirteen are recorded but not gated.
  if (stopReason === null && resume !== null && deliverables.paths.length > 0) {
    const gate = resumeDeliverableGate({
      prior: resumeBaseline,
      rows: deliverableRows,
      expected: deliverables.paths.length,
      declared: deliverables.declared,
    });
    check(gate.name, () => ({ ok: gate.ok, class: gate.class, detail: gate.detail }));
  }
  if (opts.dryWork) {
    check('the arm tree is unchanged by this run', () => {
      if (treeAfter === null || treeBefore === null) return 'no pre-run digest';
      if (treeAfter.digest === treeBefore.digest) return true;
      return `the arm changed during the run: ${treeBefore.files} file(s) before, ${treeAfter.files} after`;
    });
    if (manifestDigest !== null) {
      check('the arm still matches its pre-run manifest', () => (treeAfter.digest === manifestDigest
        ? true : `arm multiset ${treeAfter.digest} != manifest ${manifestDigest}`));
    }
    check('the work copy holds the arm', () => (copied === treeBefore.files
      ? true : `copied ${copied} file(s) of ${treeBefore.files}`));
  }
  // Deny probe, evaluated from the session log. In mock-replay it is skipped on
  // purpose (no scripted summon exists in a record); leg A still reads the
  // header, so a mount that stopped registering its restore tool still fails below.
  if (denySkipped) {
    // Fourteenth audit item 5: a skipped probe measures nothing, so the row is
    // `not-applicable` even though it can still catch a missing skip reason.
    check('deny probe skipped with a stated reason', () => (denyDoc.includes(DENY_SKIP_REASON)
      ? { ok: true, class: 'not-applicable',
        detail: 'the record carries no subagent call, so the deny probe was skipped and measured nothing' }
      : 'deny-probe.txt does not carry the skip reason'));
  }
  // Leg A stays a hard failure: a header that offers any of the six names is
  // still red, in every mode (ISSUE-038 DoD).
  check('deny leg A: the header omits the six names', () => (probe.legA.verdict === 'pass'
    ? true : progressDetail(probe)));
  // Leg B is scored as the PROBE's own outcome, not as an arm assertion
  // (ISSUE-038). On the real route a model has no reason to summon a subagent on
  // a brief that never mentions one, so `partial` is the known real-route shape
  // (round-1 SUMMARY.md item 3; the 2026-10-24 racoons arm). Counting it as an
  // arm failure made every real run exit 1 and made the documented exit 3
  // unreachable. So `partial` is never an arm assertion:
  //   - the live route: EXPECTED, recorded in `denyProbe.legBOutcome`, never flips
  //     `result.json.passed`, run exits 0.
  //   - mock lanes: the scripted summon was mandatory, so the probe is the
  //     failing thing and the run exits 3 after the arm's own assertions pass.
  // A leg B that is `fail` (a summon happened but did not fail as specified) is
  // a hard arm failure and is named by the assertion below.
  const legBScored = legBOutcome({ denySkipped, verdict: probe.legB.verdict, realApi });
  // A `fail` leg B is a broken deny surface on THIS arm (the summon went through,
  // or failed in another shape), so it is a hard failure the arm may not bench
  // on. This branch is only reachable when the summon did not fail as specified,
  // so the string detail below is the failure by construction.
  if (legBScored === 'fail') {
    check('deny leg B: the summon failed the specified UNKNOWN_TOOL shape', () => `tool-call=${probe.legB.toolCall} `
      + `code=${String(probe.legB.code)} name=${String(probe.legB.name)} text=${probe.legB.text}`);
  }
  // The read boundary (ISSUE-039), as a named assertion so the failure is in
  // `result.json` beside every other row and a reader does not have to decode
  // stderr. The detail names the offending calls; the exit code is 4, checked
  // before the generic arm failure so the cause is not hidden by a co-occurring
  // assertion.
  check(`read boundary: no call names a path ${opts.workspaceOnly
    ? 'outside the arm world or inside its evidence dir'
    : 'inside the campaign outside the arm, or inside its evidence dir'}`, () => readBoundaryGate(readReport));
  // The mount's only model-visible effect at turn 1 is its registered tool; a
  // mount that silently failed to apply would leave the header without it.
  check(`the ${opts.arm} header ${opts.arm === 'racoons' ? 'offers the restore tool' : 'has no restore tool'}`,
    () => (probe.legA.toolNames.includes(RESTORE_TOOL_NAME) === (opts.arm === 'racoons')
      ? true : `header tools: ${probe.legA.toolNames.join(',')}`));
  if (opts.arm === 'racoons') {
    check('the racoons mount row names the shipped entry', () => {
      const patch = readFileSync(patchPath, 'utf8');
      return patch.includes(pathToFileURL(pluginEntry).href) ? true
        : `patch.yml carries no file URL for ${rigWrapper ? 'the rig wrapper' : 'the shipped entry'}`;
    });
    // ISSUE-214 item 6: `capBytes`/`capHeadBytes` are ACCEPTED AND IGNORED
    // (ADR-0014 decision 1; ADR-0048 restates it product-wide). The old row
    // called them "the cap pair" and checked them as if they turned a mechanism
    // on. The record now says `capIgnored: true`, and the live bound gets its
    // own row so the two are never read as one mechanism.
    check('the mount config carries the inert cap keys (capIgnored)', () => {
      const patch = readFileSync(patchPath, 'utf8');
      const row = patch.split(/\r?\n/u).find((line) => line.startsWith('      config: '));
      let parsed = null;
      try { parsed = JSON.parse((row ?? '').slice('      config: '.length)); } catch { parsed = null; }
      if (parsed === null) return 'the mount config row is not one-line JSON';
      const facts = mountConfigFacts(parsed);
      return facts.inertValuesMatch ? true
        : `the mount config row does not carry the inert historical keys ${JSON.stringify(facts.inertKeys)}; `
          + 'they are accepted and ignored, never a mechanism this bench turns on';
    });
    check('the mount config names the live seal bound', () => {
      const patch = readFileSync(patchPath, 'utf8');
      const row = patch.split(/\r?\n/u).find((line) => line.startsWith('      config: '));
      let parsed = null;
      try { parsed = JSON.parse((row ?? '').slice('      config: '.length)); } catch { parsed = null; }
      if (parsed === null) return 'the mount config row is not one-line JSON';
      return mountConfigFacts(parsed).sealBoundMatches ? true
        : `sealMaxLatencyTurns is ${String(parsed.sealMaxLatencyTurns)}, expected ${String(LIVE_SEAL_BOUND)}`;
    });
    if (rigWrapper) {
      // The wrapper only writes where it was told: a config that lost the
      // harness paths would silently fall back to no sink and the default
      // `~/.dsh` storage root. No `ledgerPath`: the wrapper stopped injecting a
      // ledger at bb33dc7 (the entry's own per-session file is the seam).
      check('the mount config names the journal sink and the storage root', () => {
        const patch = readFileSync(patchPath, 'utf8');
        const row = patch.split(/\r?\n/u).find((line) => line.startsWith('      config: '));
        let parsed = null;
        try { parsed = JSON.parse((row ?? '').slice('      config: '.length)); } catch { parsed = null; }
        if (parsed === null) return 'the mount config row is not one-line JSON';
        if (parsed.evidenceDir !== mountHarness.evidenceDir) {
          return `evidenceDir is ${JSON.stringify(parsed.evidenceDir)}, expected ${JSON.stringify(mountHarness.evidenceDir)}`;
        }
        return parsed.crematorStorageRoot === mountHarness.storageRoot ? true
          : `crematorStorageRoot is ${JSON.stringify(parsed.crematorStorageRoot)}, expected ${JSON.stringify(mountHarness.storageRoot)}`;
      });
    }
  }
  if (opts.provider === 'mock') {
    check('the read turn succeeded', () => {
      const call = sessionEvents.find((event) => event.type === 'tool/call' && event.data?.name === 'read');
      if (call === undefined) return 'no read call in the session log';
      const result = sessionEvents.find(resultOf(String(call.data?.callId ?? '')));
      if (result === undefined) return 'the read call has no tool/result';
      return result.data?.message?.isError === true ? 'the read result is an error' : true;
    });
    check('the read result carries the smoke fact', () => {
      if (mockNeedle === null) return 'the mock script has no bench.readNeedle';
      const call = sessionEvents.find((event) => event.type === 'tool/call' && event.data?.name === 'read');
      const result = call === undefined ? undefined : sessionEvents.find(resultOf(String(call.data?.callId ?? '')));
      const text = textOfEvent(result);
      return text.includes(mockNeedle) ? true : `no ${JSON.stringify(mockNeedle)} in the read result: ${JSON.stringify(text.slice(0, 160))}`;
    });
    check('the final answer carries DENY-CONFIRMED', () => (finalEvent?.text?.includes('DENY-CONFIRMED') === true
      ? true : `stdout final text: ${JSON.stringify(finalEvent?.text ?? null)}`));
  }

  const failures = results.filter((entry) => !entry.ok);
  // A fired stopper is not a bench result, whichever stopped: a killed run must
  // never write `passed: true` (the projection gate reads this too). A
  // compaction stop (ISSUE-182) is a stopper for this purpose: the task never
  // completed, so calling it `passed: true` would state a green for work that
  // never ran — the label says what happened instead.
  const passed = failures.length === 0 && !watchdogFired && !tokenWatch.tokenFired
    && !stoppedOnCompaction && !stoppedByPolicy;
  // The ask lane's own spend, read from the journal the mount wrote. The grant
  // sees this lane through the in-run watchdog, so this post-run read is the
  // same lane's final count; an absent journal is `known: false`/`null`, never
  // a spend of zero. A resume round hands this reader the same launch byte
  // boundary the in-run watchdog used, so `askLane` and `watchdog.askInputTokens`
  // state the new leg and cannot disagree about how much of the journal is this
  // round's.
  const askLane = journal === null || journal.journal?.file === null || journal.journal?.file === undefined
    ? null
    : (() => {
      const source = new AskSource(journal.journal.file, { dir: false, startOffsets: resumeAskOffsets });
      try {
        return source.poll();
      } finally {
        source.close();
      }
    })();
  // A found journal is not a complete ask lane: an unmeasured prune table and
  // an unparsed line are spend the ask sums do not cover, so `trueTotalTokens`
  // is a lower bound unless the lane is known and carries neither. An arm with
  // no mount has no ask lane at all: that is `null`, never an incomplete lane.
  const askComplete = askLaneCompleteness({ askLaneConfigured: pluginEntry !== null, askLane });
  // A stopped run is a CENSORED PARTIAL and its citable label says so; a budget
  // stop says "by budget". Claims are gated on `benchDone.found`, never on
  // `passed`: a killed run can have no BENCH-DONE. A completed run with a failed
  // assertion is demoted too (2026-11-09 audit item 6), and the label names the
  // first failure. A grant run whose ask lane is incomplete states that its
  // true total is a lower bound; without a grant no true total is claimed.
  const citableAsForRun = runCitableAs({
    stopReason,
    citableAs,
    failures,
    // The label names the contiguous common k, the same number the stop block
    // records and a pair can compare.
    largestCheckpointReached: largestCommonK,
    expectedDeliverables: deliverables.declared ? deliverables.paths.length : null,
    benchDoneFound: doneEvent !== undefined,
    readBoundaryJudged: readReport.judged,
    askComplete: opts.tokenGrant === null ? null : askComplete,
  });
  const result = {
    schema: 'racoons-bench-run/1',
    arm: { name: opts.arm, dir: opts.armDir, manifestMultiset: manifestDigest },
    provider: opts.provider,
    // ADR-0045 (ISSUE-214 item 1): the reasoning counts, the declared floor and
    // the citable label are stated on every run. A void comparison says so even
    // when every assertion it could still make is green. The run-level label
    // also carries the removal qualifier (fifteenth audit item 2): a green run
    // with zero applied removals is a control, not a removal measurement. A
    // stopped run's label names the censored checkpoint and `benchDone.found`.
    citableAs: citableAsForRun,
    // The product's own applied-removal statement, in one place. `exercised` is
    // false exactly when `applied` is 0, and `reason` says why — a zero-removal
    // live run can no longer be told apart from a measured product effect only
    // by opening the journal. `applied` is journal-derived; the ledger's own
    // `application_removals` rows are compared by a named gate (item 6).
    removals,
    reasoning: {
      ...reasoningCounts,
      floor: reasoningVerdict.floor,
      gate: reasoningVerdict.applicable
        ? (reasoningVerdict.ok ? (reasoningVerdict.voided ? 'void' : 'pass') : 'fail')
        : 'not-applicable',
      void: reasoningVerdict.voided,
      allowZeroReasoning: opts.allowZeroReasoning,
      citableAs: reasoningVerdict.citableAs,
      detail: reasoningVerdict.detail,
    },
    // Thirteenth audit item 2: the wire-level reasoning reading. `unmeasured`
    // means NO request body was captured (the real route), so the reasoning
    // claim rests on the session log alone; `absent` means bodies were captured
    // and none carried the field; `measured` names the request and the sha256 of
    // the first reasoning string. This is a request-body reading, not network
    // capture.
    reasoningWire: {
      ...reasoningWire,
      applicable: reasoningWireVerdict.applicable,
      ok: reasoningWireVerdict.ok,
      gate: reasoningWireVerdict.status,
      detail: reasoningWireVerdict.detail,
    },
    // The official-route authorization, present only when the flag opened the
    // host this run names. Absent on every other run, so its absence states
    // "no official spend was authorized" and no existing result.json gains a key.
    ...(officialRoute === null || !opts.allowOfficialSpend ? {} : {
      officialRoute: officialAuthorizationRecord(officialRoute),
    }),
    // A resume round records the round it continues: its ordinal, the session
    // id and seq boundary, and the record it archived. A normal round keeps the
    // shape it always had (no new keys). `askJournals` is the ask lane's start
    // boundary: each journal's byte length when this launch began, so the ask
    // sums can be re-read from the same offset. It is the byte boundary the two
    // ask readers used (not a timestamp or seq); an empty list means the resumed
    // round found no journal and every ask row it writes is its own.
    ...(resume === null ? {} : {
      round: roundArchive === null ? 1 : roundArchive.round,
      resumedFrom: {
        sessionId: resume.sessionId,
        priorSeq: resume.priorSeq,
        file: resume.file,
        askJournals: [...(resumeAskOffsets ?? new Map())]
          .map(([file, bytes]) => ({ file, bytes })),
      },
      rounds: roundArchive === null ? [] : roundArchive.rounds,
    }),
    brief: resume === null
      ? { file: opts.brief, taskSha256: briefSha, taskChars: task.length }
      : { file: opts.taskFile, taskSha256: briefSha, taskChars: task.length, source: 'task-file' },
    // The manifest's own enforcement record (ISSUE-265): which blocks bound
    // this launch and which stayed informational. Present only when the launch
    // named a manifest, so a run without one gains no key.
    ...(opts.manifest === null ? {} : {
      manifest: manifestEnforcementRecord({ manifest: roundManifest, resume: resume !== null }),
    }),
    dsh: { version: dshVersion, bin: binJs, launchCommand, profile: 'headless', patches: [patchPath], patchSha256: patchSha },
    mount: pluginEntry === null ? { mounted: false }
      : { mounted: true, entry: pluginEntry, dist: pluginDist,
        // The dist's own identity (Phase R v2 R-1). A path alone cannot tell two
        // builds apart: the frozen copy carries the stamp of the build it came
        // from, and `.stamp` is inert when `--plugin-dist` names a directory
        // (the launcher only consults it for the default dist). sha256 over the
        // tree's sorted `path<TAB>sha256` lines is the field a reader compares.
        distSha256: distTreeSha256OrNull(pluginDist),
        config: mountConfig(opts, null),
        // ISSUE-214 item 6: the cap pair is accepted and ignored (ADR-0014
        // decision 1, ADR-0048), so the record states that rather than letting
        // a reader believe the bench turned a cap mechanism on. The live seal
        // bound is named separately.
        ...mountConfigFacts(mountConfig(opts, null)),
        // The wrapper adds the two seams; the shipped entry has neither.
        ...(rigWrapper ? { wrapper: RIG_WRAPPER, harness: mountHarness } : { wrapper: null }),
        fileUrl: pathToFileURL(pluginEntry).href },
    work: {
      mode: workMode,
      dir: workDir,
      copiedFiles: copied,
      // A resume round states the arm it started from and what the previous
      // rounds already left there, so `priorDeliverables` is the baseline the
      // round's own gate was judged against — never a post-run reading.
      ...(resume === null ? {} : {
        startDigest: treeBeforeLaunch.digest,
        priorDeliverables: resumeBaseline,
      }),
    },
    env: {
      DSH_HOME: homeDir,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'DISABLED',
      DSH_PERMISSION_MODE: 'danger-full-access',
      // The same TEMP/TMP/TMPDIR the child was spawned with, so the artifact
      // states where a task's intermediate temp files landed.
      ...(workspaceTemp === null ? {} : workspaceTemp.env),
      ...(realApi
        ? { RIG_CREDENTIALS_PATH: credentialsPath, RIG_SESSIONS_DIR: sessionsDir, RIG_STORAGES_DIR: storagesDir }
        : { DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(port)}`, DEEPSEEK_API_KEY: '<dummy>' }),
    },
    watchdog: {
      ...watchdogRecord({
        // `command` is the box's kill path; with `--kill-ms 0` no box was armed,
        // so the record states `null` rather than a command it never ran. The
        // `timer` key below names the state in one word.
        command: opts.killMs > 0 ? watchdogCommand : null,
        timeoutMs: opts.killMs,
        fired: watchdogFired,
        tokenGrant: opts.tokenGrant,
        tokenFired: tokenWatch.tokenFired,
        observedPromptTokens: tokenWatch.observedPromptTokens,
        // The grant is compared against the TRUE total now: main prompt + main
        // output + ask prompt + ask output + compaction prompt + compaction
        // output. `observedPromptTokens` stays the main-prompt reading for
        // every existing reader.
        trueTotalTokens: tokenWatch.trueTotalTokens,
        mainPromptTokens: tokenWatch.mainPromptTokens,
        mainOutputTokens: tokenWatch.mainOutputTokens,
        askInputTokens: tokenWatch.askInputTokens,
        askOutputTokens: tokenWatch.askOutputTokens,
        askKnown: tokenWatch.askKnown,
        // ISSUE-237: the host's native compaction call is billed usage too. The
        // pair is 0 on a run that never compacted, and `compactionUsageComplete`
        // is false when a `compaction/start` had no billable summary, which
        // makes the grant a lower bound and fails the measured-every-step gate.
        compactionPromptTokens: tokenWatch.compactionPromptTokens,
        compactionOutputTokens: tokenWatch.compactionOutputTokens,
        compactionUsageRows: tokenWatch.compactionUsageRows,
        compactionUsageComplete: tokenWatch.compactionUsageComplete,
        firedAt: tokenWatch.firedAt,
        pollMs: TOKEN_POLL_MS,
        // Fourteenth audit item 2: the watchdog's own refusal. A row with no
        // recognizable prompt field is counted, never summed, and
        // `usageReadingRefused` says the billed total is not a reading.
        usageUnrecognized: tokenWatch.usageUnrecognized,
        refused: tokenWatch.refused,
        // The watchdog's own liveness (fifteenth audit item 3): how many reads
        // the ceiling was checked on, and the poll's error when it could not
        // read. A zero reading with `error` set is a failed read, never a spend.
        polls: tokenWatch.polls,
        error: tokenWatch.error,
        // Spread only when the flag was given, so a run without it writes the
        // same `watchdog` object it always did (ISSUE-182 inertness).
        ...(opts.stopOnCompaction
          ? {
            stopOnCompaction: true,
            compactionFired: tokenWatch.compactionFired === true,
            compactionStoppedAt: tokenWatch.compactionStoppedAt ?? null,
          }
          : {}),
        // The policy stoppers' own state. Each block appears only when its flag
        // was given, so an existing run's `watchdog` object gains no keys.
        ...(opts.stopAtCheckpoint === null
          ? {}
          : {
            stopAtCheckpoint: opts.stopAtCheckpoint,
            checkpointFired: stoppedAtCheckpoint,
            checkpointStoppedAt: checkpointStop,
          }),
        ...(opts.stopAfterCompactions === null
          ? {}
          : {
            stopAfterCompactions: opts.stopAfterCompactions,
            compactionLimitFired: stoppedAfterCompactions,
            compactionLimitStoppedAt: compactionLimitStop,
          }),
        ...((opts.stopOnCompaction || opts.stopAfterCompactions)
          ? { compactions: usageWatch.compactions }
          : {}),
      }),
      // The box's own state in one word, so no reader has to infer "was a
      // wall-clock timer armed?" from a timeout value: `off` under the default
      // `--kill-ms 0`, `armed` only when a positive cap was given.
      timer: opts.killMs > 0 ? 'armed' : 'off',
      // ISSUE-214 item 4: the grant's own coverage, present only when a grant
      // was set. `complete: false` is why the run failed closed.
      ...(opts.tokenGrant === null
        ? {}
        : {
          usageCoverage: {
            assistantTurns: usageCoverage.assistantTurns,
            usageRows: usageCoverage.usageRows,
            missingRows: usageCoverage.missingRows,
            missingSeqs: usageCoverage.missingSeqs,
            complete: usageCoverage.reconciled,
          },
        }),
      // The ask lane's completeness, stated beside the true total it bounds.
      // `askKnown` in the record above says only that a journal was found;
      // `askComplete` says every prune table carried a usage row and every
      // journal line parsed. An absent journal, an unmeasured prune table or
      // an unparsed line leaves `trueTotalTokens` a lower bound; `null` says
      // this arm configures no ask lane to bound it (the vanilla arm).
      askComplete,
      pruneTablesUnmeasured: askLane === null ? null : askLane.pruneAsks,
      unparsed: askLane === null ? null : askLane.unparsed,
    },
    // The run-level label. Present only on a stopped run, so no existing
    // `result.json` gains a key: `passed: false` alone cannot say why, and the
    // difference between "an assertion failed" and "the run ended where the
    // owner asked it to" is the whole point of this instrument. `step` is the
    // step the compaction opened before (the last `step/start` plus one), which
    // is how `docs/plans/2026-10-29-prompt-forget-lanes/plan.md:22` reads the
    // same event; `billedPromptTokens` is the watchdog's own counter at the poll
    // that read the row — the spend up to the stop, not a post-hoc derivation.
    ...(stoppedOnCompaction
      ? {
        stoppedOnCompaction: true,
        compactionStop: {
          seq: compactionStop.seq ?? null,
          step: compactionStop.step ?? null,
          turn: compactionStop.turn ?? null,
          billedPromptTokens: compactionStop.billedPromptTokens ?? null,
          compactions: compactionStop.compactions ?? null,
          firedAt: compactionStop.firedAt ?? null,
          // True when the reap found a live child and killed it; false when the
          // child had already exited and the row was written by its own end (the
          // mock-replay lane does this). Either way the landmark is real; the
          // flag stops a run, it does not invent one.
          killLanded: compactionKillLanded,
          exitCode: EXIT_CODES.armFailed,
          exitName: 'stopped-on-compaction',
          note: (compactionKillLanded
            ? 'the tree was killed at the first native compaction through the same taskkill path '
              + 'the kill box uses'
            : 'the first native compaction was recorded at the end of the child\'s own run, so there '
              + 'was no live tree to kill')
            + '. Not a completed task and not a failure; result.json.passed is false because the task '
            + 'never completed',
        },
      }
      : {}),
    // The 2026-11-08 work-checkpoint stop. It is a CENSORED PARTIAL: the child
    // was killed at the owner's chosen checkpoint, so the task never completed.
    // The block is self-contained for the results note: stop reason, the file
    // and its billed total, `benchDone.found` (the claim gate, never `passed`),
    // the work reached, the peak, the compaction positions and the product's own
    // journal/ledger totals. The full step series lives in `context.series` and
    // the session log, so any k can be recomputed after the run.
    ...(stoppedAtCheckpoint
      ? {
        stoppedAtCheckpoint: true,
        stoppedBy: 'checkpoint',
        stop: {
          reason: 'checkpoint',
          censored: true,
          exitName: 'stopped-at-checkpoint',
          exitCode: EXIT_CODES.armFailed,
          checkpoint: {
            path: checkpointStop.path ?? opts.stopAtCheckpoint,
            resolved: checkpointStop.resolved ?? null,
            presentAtLaunch: false,
            firedAt: checkpointStop.firedAt ?? null,
            billedPromptTokens: checkpointStop.billedPromptTokens ?? null,
            compactions: checkpointStop.compactions ?? null,
            killLanded: checkpointStop.killLanded === true,
          },
          benchDone: {
            found: doneEvent !== undefined,
            seq: doneEvent?.seq ?? null,
          },
          deliverablesCreated,
          filesPresent: deliverablesCreated,
          largestCheckpointReached,
          largestCommonK,
          peak: context.peak,
          compaction: { count: compaction.count, atRequests: compaction.atRequests },
          journalTotals: journal?.journal === null || journal?.journal === undefined ? null : {
            lines: journal.journal.lines,
            byKind: journal.journal.byKind,
            appliedRemovals: journal.journal.appliedRemovals,
            recalls: journal.journal.recalls,
            ledger: journal.ledger,
          },
          askLane: askLane === null ? null : {
            known: askLane.known,
            askTokens: askLane.known ? askLane.askTokens : null,
            askOutputTokens: askLane.known ? askLane.askOutputTokens : null,
            exchanges: askLane.exchanges,
            pruneTablesUnmeasured: askLane.pruneAsks,
            unparsed: askLane.unparsed,
          },
          note: (checkpointStop.killLanded === true
            ? 'the tree was killed at the checkpoint through the same taskkill path the kill box uses'
            : 'the checkpoint was present at the final read after the child had already ended, '
              + 'so there was no live tree to kill')
            + '. Censored partial, not a completed task and not a failure: result.json.passed is false '
            + 'because the task never completed, and claims are gated on benchDone.found, never passed',
        },
      }
      : {}),
    ...(stoppedAfterCompactions
      ? {
        stoppedAfterCompactions: true,
        stoppedBy: 'compactions',
        stop: {
          reason: 'compactions',
          censored: true,
          exitName: 'stopped-after-compactions',
          exitCode: EXIT_CODES.armFailed,
          compactionLimit: {
            limit: compactionLimitStop.limit ?? opts.stopAfterCompactions,
            observed: compactionLimitStop.observed ?? null,
            nthSeq: compactionLimitStop.limit === undefined
              ? null : compaction.atSeqs[compactionLimitStop.limit - 1] ?? null,
            nthRequest: compactionLimitStop.limit === undefined
              ? null : compaction.atRequests[compactionLimitStop.limit - 1] ?? null,
            firedAt: compactionLimitStop.firedAt ?? null,
            billedPromptTokens: compactionLimitStop.billedPromptTokens ?? null,
            killLanded: compactionLimitStop.killLanded === true,
          },
          benchDone: { found: doneEvent !== undefined, seq: doneEvent?.seq ?? null },
          deliverablesCreated,
          filesPresent: deliverablesCreated,
          largestCheckpointReached,
          largestCommonK,
          peak: context.peak,
          compaction: { count: compaction.count, atRequests: compaction.atRequests },
          journalTotals: journal?.journal === null || journal?.journal === undefined ? null : {
            lines: journal.journal.lines,
            byKind: journal.journal.byKind,
            appliedRemovals: journal.journal.appliedRemovals,
            recalls: journal.journal.recalls,
            ledger: journal.ledger,
          },
          askLane: askLane === null ? null : {
            known: askLane.known,
            askTokens: askLane.known ? askLane.askTokens : null,
            askOutputTokens: askLane.known ? askLane.askOutputTokens : null,
            exchanges: askLane.exchanges,
            pruneTablesUnmeasured: askLane.pruneAsks,
            unparsed: askLane.unparsed,
          },
          note: 'Censored partial at the Nth native compaction, not a completed task and not a failure: '
            + 'claims are gated on benchDone.found, never passed',
        },
      }
      : {}),
    // A fired token grant is a CENSORED PARTIAL by budget (glossary: "the run
    // cap and stop"): the ceiling was crossed at the true total it was decided
    // on, so the run is not a measurement. The watchdog kills a live tree; a
    // grant that fires on the final read after the child exited records
    // `killLanded: false` rather than claiming a kill it did not need. The
    // block states the grant and every stream the true total adds up, so a
    // reader can recompute the fire without opening the watchdog record. Claims
    // are gated on `benchDone.found`, never on `passed`.
    ...(tokenWatch.tokenFired
      ? {
        stoppedByBudget: true,
        stop: {
          reason: 'budget',
          censored: true,
          exitName: 'stopped-by-budget',
          exitCode: EXIT_CODES.armFailed,
          budget: {
            grant: opts.tokenGrant,
            trueTotalTokens: tokenWatch.trueTotalTokens,
            mainPromptTokens: tokenWatch.mainPromptTokens,
            mainOutputTokens: tokenWatch.mainOutputTokens,
            askInputTokens: tokenWatch.askInputTokens,
            askOutputTokens: tokenWatch.askOutputTokens,
            askKnown: tokenWatch.askKnown,
            // The ask lane's completeness at the fire: `askKnown` alone would
            // let an unmeasured prune table or an unparsed line read as a
            // complete total. `null` is an arm with no ask lane configured.
            askComplete,
            pruneTablesUnmeasured: askLane === null ? null : askLane.pruneAsks,
            unparsed: askLane === null ? null : askLane.unparsed,
            polls: tokenWatch.polls,
            firedAt: tokenWatch.firedAt ?? null,
            // True only when `reap()` found a live child; a grant that fired on
            // the final read after the child exited records false.
            killLanded: grantKillLanded,
          },
          benchDone: { found: doneEvent !== undefined, seq: doneEvent?.seq ?? null },
          deliverablesCreated,
          filesPresent: deliverablesCreated,
          largestCheckpointReached,
          largestCommonK,
          peak: context.peak,
          compaction: { count: compaction.count, atRequests: compaction.atRequests },
          journalTotals: journal?.journal === null || journal?.journal === undefined ? null : {
            lines: journal.journal.lines,
            byKind: journal.journal.byKind,
            appliedRemovals: journal.journal.appliedRemovals,
            recalls: journal.journal.recalls,
            ledger: journal.ledger,
          },
          askLane: askLane === null ? null : {
            known: askLane.known,
            askTokens: askLane.known ? askLane.askTokens : null,
            askOutputTokens: askLane.known ? askLane.askOutputTokens : null,
            exchanges: askLane.exchanges,
            pruneTablesUnmeasured: askLane.pruneAsks,
            unparsed: askLane.unparsed,
          },
          note: budgetStopNote({
            killLanded: grantKillLanded,
            benchDoneFound: doneEvent !== undefined,
          }),
        },
      }
      : {}),
    // The work-checkpoint reading, present on every run so a stopped run and a
    // completed run state the same paths. `expected` is the derived list's
    // length and `paths` is that list in the brief's order, so a longer brief's
    // table has one row per expected deliverable. `created`/`filesPresent`
    // count the files in the work copy; `largestReached` is the highest present
    // k and `largestCommonK` the longest contiguous prefix (rows k=1,2,4 => 2),
    // which is the k a pair can compare.
    checkpoints: checkpointsBlock({
      paths: deliverables.paths,
      source: deliverables.source,
      rows: deliverableRows,
    }),
    // One word for what ended the run, present only on a stopped run. `passed`
    // is false on every stop; `stoppedBy` says which instrument stopped it, so
    // a reader never has to infer it from four separate blocks.
    ...(stopReason === null ? {} : { stoppedBy: stopReason }),
    // The ask lane's true cost, read from the mount's journal. The grant's true
    // total includes this lane (ask prompt + ask output) as two of its six
    // streams; a journal with no ask rows reads `known: true, askTokens: 0`,
    // and an absent journal is `null`, never a spend of zero.
    ...(askLane === null
      ? { askLane: null }
      : {
        askLane: {
          known: askLane.known,
          askTokens: askLane.known ? askLane.askTokens : null,
          askOutputTokens: askLane.known ? askLane.askOutputTokens : null,
          exchanges: askLane.exchanges,
          pruneTablesUnmeasured: askLane.pruneAsks,
          unparsed: askLane.unparsed,
          files: askLane.files,
          note: 'MAIN prompt is one of the grant\'s six true-total streams; this is the ask lane '
            + 'beside it. Prune tables with no `prune-ask` usage row are counted as unmeasured, '
            + 'never assumed small',
        },
      }),
    exit: { code: exit.code, signal: exit.signal, startedAt, finishedAt, durationMs },
    mock: mock === null
      ? { started: false }
      : { started: true, port, requests: requests.length, main: mains.length, title: titles.length,
        // `table` is every ask that carried the table frame; since ADR-0028 the
        // bulk prune is the one asker, so `table` and the rows that answered it
        // are the same lane.
        table: requests.filter((entry) => entry.kind === 'prune').length,
        prune: requests.filter((entry) => String(entry.matched).startsWith('prune-table-forgetall-')).length,
        compaction: compactionAsks.length, postCompaction: postCompactionRequests.length },
    // The mock fabricates usage (`estimateTokens(chars)`), so a mock arm's token
    // rows are shape, not spend (ISSUE-023 §6). Update quality is out of scope
    // in the same way: a scripted model writes no prose of its own. Synthetic
    // pressure changes the SIZE of what the model saw, never the honesty of the
    // token rows: a padded run is still estimated, and says so twice.
    usageIsEstimated: !realApi,
    // The real route's journal, in the same summary the replay lane carries in
    // `mockReplay.journal` (ISSUE-082). Present only when a journal was scanned
    // and no replay block already states one, so a mock-replay `result.json`
    // keeps its shape. `mounted` is the mount-only line, spelled out: it names
    // the storage root this run opened, which no hand-written stub can know.
    ...(journal === null || replay !== null ? {} : {
      journal: {
        verdict: journal.verdict,
        emitted: journal.emitted,
        file: journal.journal?.file ?? null,
        bytes: journal.journal?.bytes ?? null,
        lines: journal.journal?.lines ?? 0,
        byKind: journal.journal?.byKind ?? {},
        // The refusal class ISSUE-076 could not recover: every ask outcome the
        // mount wrote is countable here, with its code, on the real path.
        entryAsks: (journal.journal?.byKind?.['entry-ask'] ?? 0)
          + (journal.journal?.byKind?.['entry-ask-refused'] ?? 0)
          + (journal.journal?.byKind?.['entry-ask-off'] ?? 0),
        // How many times the prune bar FIRED, which is the headline a live run
        // is read for. Not the raw line count: the mount writes one
        // `prune-threshold` line per evaluation and `crossed` marks the fires.
        // A pre-change run has no `crossed` and every line was a fire, so this
        // stays the same number on old evidence. The evaluation count is stated
        // beside it so the two can never be confused for one another.
        pruneThresholds: journal.journal?.pruneFires ?? 0,
        pruneThresholdEvaluations: journal.journal?.pruneThresholdEvaluations ?? 0,
        mounted: journal.journal?.mounted ?? null,
        ledger: journal.ledger,
        unparsable: journal.unparsable,
      },
    }),
    // ── Context pressure and host compaction ─────────────────────────────────
    // Recorded for EVERY provider (ISSUE-214 item 2). On the mock lanes the
    // series is the model-visible request body in bytes per conversation turn;
    // on a real route, where no request-body log exists, it is the session
    // log's billed prompt tokens per assistant turn. Neither is `null`, so a
    // run can be compared without re-deriving which lane wrote it.
    //
    // The trigger figure is INFORMATIONAL and lives on the host's meter: the
    // host prices content blocks, per-message framing and a routed baseline, so
    // `body_bytes / 4` is a different unit from the one the trigger is stated
    // in, and it UNDERSTATES the host's count (a vanilla arm compacted at a
    // bytes/4 estimate of 674,043 — under the 678,464 trigger — which is why no
    // gate may derive a threshold from bytes). No assertion reads either key;
    // the gates read the `compaction/start` and `compaction/end` events.
    context: {
      ...context,
      // The host-trigger comparison is a byte-series reading; a token series
      // would be a different quantity under the same name.
      ...(context.unit === 'bytes' ? {
        trigger: {
          tokens: PRESSURE_TRIGGER_TOKENS,
          meter: 'host',
          note: 'compaction-basic fires on the host token meter, not on request bytes; '
            + 'bytes/4 understates it and is never compared to this figure by a gate',
        },
        peakBytesEstimate: {
          tokens: Math.round(context.peak / BYTES_PER_TOKEN),
          bytesPerToken: BYTES_PER_TOKEN,
          note: 'estimate for a reader only; not the host meter, not an assertion input',
        },
      } : {}),
    },
    // `count` is `compaction/start` records in the session log: a condensation
    // the host actually opened. `atRequests` is the 1-based conversation-turn
    // index it opened before. `pruneEvents` is the tool-result pruner's own
    // `compaction/prune` count, kept separate on purpose: it is a different
    // mechanism and must never be read as a compaction. `compacted` is the
    // comparison flag: a run that compacted is recorded, never refused.
    compaction,
    // ── The host's competing pruner (ADR-0041; arm rule 2026-11-09) ───────────
    // The expected state is the ARM's, and it is stated on every record, not
    // buried in the pressure block: `racoons` disables the host pruner so the
    // mount is the only remover; `vanilla` leaves the host at its default (on).
    // `hostPrunerRecord` carries the field set: state, the patch's own rows,
    // the composed read-back, and the session log's prune count.
    hostPruner: hostPrunerRecord({
      arm: opts.arm,
      allowHostPruner: opts.allowHostPruner,
      endPressureIsolation: opts.endPressureIsolation,
      patchTally,
      isolation,
      pruneEvents: compaction.pruneEvents,
      pruneShadowedTokens: sessionEvents
        .filter((event) => event.type === 'compaction/prune')
        .reduce((total, event) => total + (Number.isFinite(event.data?.shadowedTokenCount)
          ? event.data.shadowedTokenCount : 0), 0),
    }),
    syntheticPressure: opts.inflateBytes === null
      ? { enabled: false }
      : {
        enabled: true,
        minBytes: opts.inflateBytes,
        // What was actually asked of the scripted commands, and how many.
        fillerLines: replay?.inflation?.lines ?? 0,
        paddedResults: replay?.inflation?.results ?? 0,
        fillerLine: '[synthetic pressure row <k>]',
        // What the host ACTUALLY delivered, measured from the session log's
        // tool/result rows: the filler is a request to the command, and the
        // host's own post-execute caps (spill-policy `maxInlineTokens` 12,500
        // ≈ 50,000 chars) clip it. A reader must compare `minBytes` to these,
        // never assume the request was delivered whole.
        delivered: deliveredResultBytes(sessionEvents),
        // The one sentence a reader must have when reading any number above.
        honesty: 'synthetic pressure measures the cap/compaction MECHANISM under load, '
          + 'not real-record economics',
        // The host-pruner state this run made, in the pressure block's own
        // words. It is the same arm rule `result.json.hostPruner` states; it
        // stays here because a reader of the pressure block must not have to
        // look elsewhere to know whether the pruner could relieve the injected
        // pressure first. `applied` is read back from
        // `dump-config-host-pruner.yml`, never asserted from the patch text:
        // the patch is what was asked, the dump is what the child mounts.
        isolation: {
          row: HOST_PRUNER_ID,
          arm: opts.arm,
          state: prunerState,
          // True when this run asked for the disable row; `applied` says the
          // composed config actually disabled every copy of it. Vanilla's
          // `host-default` asks for nothing, so both are false there.
          requested: prunerState === HOST_PRUNER_DISABLED,
          ended: prunerState === HOST_PRUNER_HOST_DEFAULT,
          applied: isolation === null ? false : isolation.applied,
          source: isolation === null ? null : isolation.source,
          composedRows: isolation === null ? 0 : isolation.rows,
          disabledRows: isolation === null ? 0 : isolation.disabledRows,
          ...(isolation === null || isolation.error === null ? {} : { error: isolation.error }),
        },
      },
    ...(replay === null ? {} : {
      mockReplay: {
        record: replay.record,
        map: replay.map,
        textCap: replay.stats.textCap,
        maxReplies: replay.stats.maxReplies,
        textMode: replay.stats.textMode,
        scriptedReplies: replay.stats.scriptedReplies,
        terminator: replay.stats.terminator,
        // The replay-external prefix this run served (0 for the vanilla arm)
        // and the asks it answered. Evidence, not a target: a record with no
        // prune table asks nothing and stays green at 0. Since ADR-0028 the bulk
        // prune is the ONE table asker, so `tableAsks` and `pruneAsks` are the
        // same lane and no row-count split exists (`PRUNE_MATCH_PATTERN`).
        pruneRows: replay.pruneRows.length,
        tableAsks: requests.filter((entry) => entry.kind === 'prune').length,
        pruneAsks: requests.filter((entry) => String(entry.matched).startsWith('prune-table-forgetall-')).length,
        // The row-count histogram, kept as evidence so a reader can see every
        // prune table's size (the tail of a pass is often 1 row).
        tableRows: requests.filter((entry) => entry.kind === 'prune')
          .map((entry) => tableRowCount(entry.body)),
        blocker: replay.stats.turns.blocker,
        droppedAfterBlocker: replay.stats.turns.dropped_after_blocker,
        // ISSUE-214 item 7: the consumption claim as a PREFIX, recorded beside
        // the check. `cutByCompaction` says why it stopped; a full replay is
        // `consumed === scripted` with the flag false.
        consumedPrefix: {
          consumed: replayPrefix.consumed,
          scripted: replayPrefix.scripted,
          cutByCompaction: compactionCut,
        },
        cutByCompaction: compactionCut,
        mocks: replay.stats.calls,
        targets: replay.stats.targets,
        scriptSha256,
        // Every tool result, with its error code: a replayed `edit` whose
        // recorded `old_string` is not in the arm is visible here, not hidden.
        toolResults: toolResultRows,
        toolFailures: toolResultRows.filter((row) => row.isError).length,
        // Fidelity: the failure multiset the SCRIPT must produce, beside the one
        // it did. The journal/ledger counts live beside it in `mockReplay.journal`,
        // because they are racoons-side evidence, not a fidelity expectation.
        fidelity: {
          expectedFailures,
          unexpectedFailures: toolResultRows.filter((row) => row.isError
            && expectedFailures.detail.every((entry) => entry.tool !== row.tool || entry.code !== (row.code ?? 'no-code'))),
          journalEmitted: journal.emitted,
          ...(opts.perturbSwapMatch === null
            ? {}
            : { perturbSwapMatch: opts.perturbSwapMatch, note: 'perturbed script: this run must fail the request-key gate' }),
        },
        // The racoons arm's own evidence. `lines` and `byKind` describe the file
        // the mount wrote; the cap/seal/recall counts are read out of those kinds.
        // They describe what this mount did to this record — proof the seams
        // fired — and are never a target the run is tuned toward.
        journal: {
          verdict: journal.verdict,
          emitted: journal.emitted,
          file: journal.journal?.file ?? null,
          bytes: journal.journal?.bytes ?? null,
          lines: journal.journal?.lines ?? 0,
          byKind: journal.journal?.byKind ?? {},
          // The mount's own line, so a reader can see the storage root the run
          // opened without re-reading the file (ISSUE-082).
          mounted: journal.journal?.mounted ?? null,
          capArchives: journal.journal?.capArchives ?? 0,
          evictArchives: journal.journal?.evictArchives ?? 0,
          verdictArchives: journal.journal?.verdictArchives ?? 0,
          sealEpisodes: journal.journal?.sealEpisodes ?? 0,
          negativeFacts: journal.journal?.negativeFacts ?? 0,
          recalls: journal.journal?.recalls ?? 0,
          failedResultSkips: journal.journal?.failedResultSkips ?? 0,
          // Fires, not evaluation lines: `byKind['prune-threshold']` above is
          // the evaluation count, and on this lane too the headline is fires.
          pruneFires: journal.journal?.pruneFires ?? 0,
          ruleIds: journal.journal?.ruleIds ?? {},
          // The applied-removal lanes the replacement gate compares against the
          // session log's `tool/result` replaces (ISSUE-089).
          appliedRemovals: journal.journal?.appliedRemovals ?? 0,
          landedEntries: journal.journal?.landedEntries ?? 0,
          appliedForgets: journal.journal?.appliedForgets ?? 0,
          rewinds: journal.journal?.rewinds ?? 0,
          ledger: journal.ledger,
          unparsable: journal.unparsable,
          ...(opts.perturbJournalCaps === null
            ? {}
            : { perturbJournalCaps: opts.perturbJournalCaps,
              note: 'the journal counts were shifted in memory: this run must fail the journal gates' }),
          ...(opts.perturbJournalParse
            ? { perturbJournalParse: true,
              note: 'a non-JSON line was appended to the journal: this run must fail the parse gate' }
            : {}),
        },
      },
    }),
    ...(projection === null ? {} : {
      projection: {
        out: opts.projectionOut,
        in: opts.projectionIn,
        diffs: projectionDiffs,
        ...(projectionSchemaError === null ? {} : { error: projectionSchemaError }),
      },
    }),
    usage,
    // ISSUE-214 item 10: the request log's sha256 is the hash of the same bytes
    // the request rows were parsed from (one read), and malformed lines are
    // counted with their 1-based numbers.
    requestLog: {
      file: requestLog,
      present: requestSnapshot.present,
      bytes: requestSnapshot.bytes,
      sha256: requestSnapshot.sha256,
      lines: requests.filter((entry) => entry.type !== 'unparsed').length,
      malformed: requestSnapshot.malformed.map((row) => row.line),
    },
    session: {
      files: sessionFiles,
      // One entry per session file: the hash of the bytes `events` came from.
      digests: sessionSnapshots.map((snapshot) => ({
        file: snapshot.file,
        present: snapshot.present,
        bytes: snapshot.bytes,
        sha256: snapshot.sha256,
        malformed: snapshot.malformed.map((row) => row.line),
      })),
      events: sessionEvents.length,
      malformed: sessionSnapshots.flatMap((snapshot) => snapshot.malformed.map((row) => ({
        file: snapshot.file,
        line: row.line,
      }))),
      benchDone: doneEvent === undefined
        ? { found: false }
        : { found: true, seq: doneEvent.seq, line: doneLine },
    },
    // The arm tree's identity, read before the launch on every run (fifteenth
    // audit item 5). A dry-work run keeps the before/after pair so the pristine
    // arm claim can be checked; a real run edits the arm in place, so only the
    // pre-launch digest is stated — that is the value the round manifest's
    // `image.digest` was compared to.
    tree: opts.dryWork
      ? { checked: true, digest: treeBefore.digest, before: treeBefore, after: treeAfter,
        manifestMultiset: manifestDigest }
      : { checked: true, digest: treeBeforeLaunch.digest, files: treeBeforeLaunch.files },
    denyProbe: denySkipped
      ? { verdict: 'skipped', reason: DENY_SKIP_REASON, legA: probe.legA }
      : { legA: probe.legA, legB: probe.legB, verdict: probe.verdict, legBOutcome: legBScored },
    readBoundary,
    // The `--deny-web` intent, stated in the run's own record. The composed rows
    // are proved by the preflight's `web-tools=DENIED` line and the dump; this
    // block says which four ids the run asked to close, so a result without it
    // states "no web deny was requested" unambiguously.
    ...(opts.denyWeb
      ? { webTools: { denied: true, deniedBy: '--deny-web', rows: WEB_ROUTE_IDS } }
      : {}),
    // Thirteenth audit item 7: the same counts the PASS line prints, so a
    // reader of the artifact can tell a measured pass from an empty one without
    // counting `class` values by hand.
    assertionSummary: assertionSummaryOf(results),
    assertions: results,
    passed,
  };
  writeFileSync(join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);

  // A baseline is only worth storing when the run it came from was green: a
  // projection written from a failing run would bake the failure into the next
  // comparison and every later run would match it.
  let projectionNote = null;
  if (projectionText !== null && opts.projectionOut !== null) {
    if (!passed) {
      projectionNote = `projection NOT written: this run failed ${String(failures.length)} assertion(s); `
        + 'a baseline must come from a green run';
    } else {
      mkdirSync(dirname(opts.projectionOut), { recursive: true });
      writeFileSync(opts.projectionOut, projectionText);
      projectionNote = `projection written ${opts.projectionOut} (${String(projection.requests.length)} request(s), `
        + `${String(projection.tool_calls.length)} call(s), ${String(projection.tool_failures.count)} failure(s))`;
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  process.stdout.write(`${denyDoc}`);
  process.stdout.write(`evidence ${evidenceDir}\n`);
  // The numbers the mode exists to produce, stated by the run rather than
  // derived later by hand: a reader who sees only the console still gets them.
  // `context.unit` says which measure the artifact holds: bytes on a mock lane,
  // billed prompt tokens on a real route (ISSUE-214 item 2).
  const contextUnit = context.unit === 'bytes' ? 'B' : 'tok';
  process.stdout.write(`context unit=${context.unit} ${String(context.series.length)} turn(s) `
    + `peak=${String(context.peak)} ${contextUnit} at ${context.unit === 'bytes' ? 'request' : 'turn'} `
    + `${String(context.peakRequest)} final=${String(context.final)} ${contextUnit}\n`);
  process.stdout.write(`compaction count=${String(compaction.count)}`
    + `${compaction.atRequests.length === 0 ? '' : ` at request ${compaction.atRequests.join(',')}`}`
    + ` closed=${String(compaction.ends)} pruner-events=${String(compaction.pruneEvents)}\n`);
  // The removal statement on every run, so a zero-removal live run is readable
  // from the console (fifteenth audit item 2).
  process.stdout.write(`removals applied=${String(removals.applied)} exercised=${String(removals.exercised)} `
    + `(${removals.reason})\n`);
  // The arm's pruner state is stated on every run, so a reader who sees only
  // the console still knows whether the mount was the only remover.
  process.stdout.write(`host-pruner ${HOST_PRUNER_ID} arm=${opts.arm} state=${prunerState} `
    + `patch-rows=${String(patchTally.rows)} patch-pruner-rows=${String(patchTally.hostPrunerRows)} `
    + `composed=${String(isolation.disabledRows)}/${String(isolation.rows)} disabled `
    + `prune-events=${String(compaction.pruneEvents)}\n`);
  if (opts.inflateBytes !== null) {
    const delivered = deliveredResultBytes(sessionEvents);
    process.stdout.write(`synthetic pressure minBytes=${String(opts.inflateBytes)} `
      + `padded=${String(replay?.inflation?.results ?? 0)} call(s) `
      + `delivered min=${String(delivered.min)} median=${String(delivered.median)} max=${String(delivered.max)} B `
      + '(MECHANISM only, not real-record economics)\n');
  }
  if (projectionNote !== null) process.stdout.write(`${projectionNote}\n`);
  if (projectionDiffs !== null && projectionDiffs.length === 0) {
    process.stdout.write(`projection identical to ${opts.projectionIn} (${String(Object.keys(projection).length)} keys)\n`);
  }
  if (journal !== null) {
    if (opts.arm !== 'racoons') {
      process.stdout.write(`journal emitted=${String(journal.emitted)} (vanilla arm: expected none)\n`);
    } else if (journal.journal === null) {
      process.stdout.write('journal emitted=false (racoons arm: the mount supplied no sink)\n');
    } else {
      const counts = journal.journal;
      process.stdout.write(`journal ${counts.file} verdict=${journal.verdict} lines=${String(counts.lines)} `
        + `kinds=${JSON.stringify(counts.byKind)}\n`);
      process.stdout.write(`journal cap=${String(counts.capArchives)} seal=${String(counts.sealEpisodes)} `
        + `negative-facts=${String(counts.negativeFacts)} recall=${String(counts.recalls)} `
        + `verdict-archives=${String(counts.verdictArchives)} evict=${String(counts.evictArchives)}\n`);
      // The applied-removal lanes beside them, so the replacement gate's
      // expected side is readable without re-parsing the journal (ISSUE-089).
      process.stdout.write(`journal lanes applied-removals=${String(counts.appliedRemovals)} `
        + `landed-entries=${String(counts.landedEntries)} applied-forgets=${String(counts.appliedForgets)} `
        + `rewinds=${String(counts.rewinds)}\n`);
      const ledger = journal.ledger;
      process.stdout.write(ledger.present
        ? `ledger ${String(ledger.file)} via=${String(ledger.via)}`
          + `${ledger.deprecated === true ? ' (DEPRECATED host-injected path)' : ''} `
          + `readable=${String(ledger.readable)} `
          + `events=${JSON.stringify(ledger.events)} removals=${JSON.stringify(ledger.applications)} `
          + `recalls=${String(ledger.recallIds.length)}\n`
        : `ledger absent at ${String(ledger.primary ?? ledger.file)} `
          + `(legacy ${String(ledger.legacy ?? 'n/a')})\n`);
    }
  }
  if (expectedFailures !== null) {
    process.stdout.write(`fidelity expected failures ${String(expectedFailures.count)} ${JSON.stringify(expectedFailures.by_code)} `
      + `over ${JSON.stringify(expectedFailures.by_tool)}\n`);
  }
  if (opts.perturbSwapMatch !== null) {
    process.stdout.write(`perturbation: matchers of replies ${opts.perturbSwapMatch.join(',')} swapped in the served script; `
      + 'this run must fail the request-key gate\n');
  }
  if (opts.perturbJournalCaps !== null) {
    process.stdout.write(`perturbation: the journal's cap count was shifted by ${String(opts.perturbJournalCaps)} in memory; `
      + 'this run must fail the zero-caps gate (ADR-0014)\n');
  }
  if (opts.perturbJournalParse) {
    process.stdout.write('perturbation: a non-JSON line was appended to the journal; '
      + 'this run must fail the parse gate\n');
  }
  for (const failure of failures) process.stderr.write(`FAIL: ${failure.name}: ${failure.detail ?? ''}\n`);
  // Three stoppers, one accounting rule: a run the box killed, a run the grant
  // killed and a run stopped at the first native compaction were all killed by
  // this launcher, so none of them is a bench result and all take exit 1 ahead of
  // every assertion outcome. Routing the grant through `watchdogFired` is what
  // guarantees the code is the SAME one the kill box produces
  // (EXIT_CODES.armFailed) rather than a new code invented for spend; the
  // compaction stop takes `stoppedOnCompaction` (ISSUE-182) and the same code,
  // because 0 would read as a completed task and a new code would read as a new
  // failure class. The LABEL carries the difference, and it is printed below.
  const stopped = watchdogFired || tokenWatch.tokenFired || stoppedByPolicy;
  const exitCode = exitCodeFor({
    watchdogFired: stopped, failures: failures.length, violations: readReport.violations.length, denySkipped,
    verdict: probe.verdict, realApi, stoppedOnCompaction,
  });
  if (watchdogFired) {
    process.stderr.write(`FAIL: the kill box fired after ${String(opts.killMs)} ms\n`);
  }
  if (tokenWatch.tokenFired) {
    process.stderr.write(`FAIL: the token grant fired at ${String(tokenWatch.trueTotalTokens ?? tokenWatch.observedPromptTokens)} true tokens `
      + `(main-prompt component ${String(tokenWatch.observedPromptTokens)}; grant ${String(opts.tokenGrant)}) after ${String(tokenWatch.polls)} poll(s); `
      + 'the launch budget is spent, so this run is a timeout\n');
  }
  // Not a `FAIL:` line on purpose. A stop-on-compaction run did what it was
  // launched to do; printing failure wording for it would make a correct early
  // stop look like a defect in the next reader's grep. The exit code is still 1
  // and the word `stopped` is in both the stderr line and the stdout label, so
  // neither a green nor a crash can be mistaken for it.
  if (stoppedOnCompaction) {
    process.stderr.write(`STOPPED ON COMPACTION: first compaction/start at seq ${String(compactionStop.seq)} `
      + `(step ${String(compactionStop.step)}, turn ${String(compactionStop.turn)}) after `
      + `${String(compactionStop.billedPromptTokens)} billed prompt tokens; `
      + (compactionKillLanded
        ? 'the tree was killed through the same taskkill path the kill box uses, so the steps after it '
          + 'were never paid for. '
        : 'the child had already ended when the row was read, so there was no live tree to kill; '
          + 'the run still ends here rather than being reported as a completed task. ')
      + 'Exit 1, name stopped-on-compaction: not a green (the task did not complete) and not a failure\n');
  }
  if (stoppedAtCheckpoint) {
    process.stderr.write(`STOPPED AT CHECKPOINT: ${String(checkpointStop.path)} appeared after `
      + `${String(checkpointStop.billedPromptTokens)} billed prompt tokens (${String(checkpointStop.compactions)} `
      + `native compaction(s)); ${String(deliverablesCreated)}/${String(deliverables.paths.length)} deliverable(s) `
      + `created (files present) ${String(deliverablesCreated)}/${String(deliverables.paths.length)}, `
      + `largest contiguous k=${String(largestCommonK)}, benchDone.found=${String(doneEvent !== undefined)}. `
      + (checkpointStop.killLanded === true
        ? 'the tree was killed through the same taskkill path the kill box uses. '
        : 'the child had already ended when the file was read, so there was no live tree to kill. ')
      + 'Censored partial, not a failure; claims are gated on benchDone.found, never passed\n');
  }
  if (stoppedAfterCompactions) {
    process.stderr.write(`STOPPED AFTER COMPACTIONS: ${String(compactionLimitStop.limit)} native compaction(s) `
      + `observed (${String(compactionLimitStop.observed)} at the fire) after `
      + `${String(compactionLimitStop.billedPromptTokens)} billed prompt tokens; `
      + `${String(deliverablesCreated)}/${String(deliverables.paths.length)} deliverable(s) present, `
      + `created (files present) ${String(deliverablesCreated)}/${String(deliverables.paths.length)}, `
      + `largest contiguous k=${String(largestCommonK)}, benchDone.found=${String(doneEvent !== undefined)}. `
      + 'Censored partial, not a failure\n');
  }
  // Every exit code the header documents has an exercised path (ISSUE-038 DoD):
  // 1 above and here, 2 in `refuse`, 3 below, 4 at the read boundary.
  if (exitCode === EXIT_CODES.readOutOfScope) {
    for (const row of readReport.violations) {
      process.stderr.write(`READ OUT OF SCOPE: ${describeReadViolation(row)} (resolved ${row.resolved})\n`);
    }
    process.stderr.write(`FAIL: the arm named ${String(readReport.violations.length)} path(s) `
      + `${opts.workspaceOnly ? 'outside its world' : 'inside the campaign tree but outside its world'} `
      + `(${worldRoots.join(', ')}); this run cannot ${opts.workspaceOnly ? 'be read as workspace-only' : 'pair with the other arm'}\n`);
  }
  if (exitCode === EXIT_CODES.denyPartial) {
    process.stderr.write('DENY PARTIAL: the model never attempted the summon; header-only proof, not a green probe\n');
    process.stderr.write('exit 3: the arm itself passed every assertion; the deny probe is the known real-route shape\n');
  }
  // Recorded, never gated (read-boundary.mjs: the campaign line is the gate, and
  // this content has no path inside it). Printed on every exit so a verdict
  // cannot miss that the arm reached a repository above its world.
  if (readReport.gitChannel.length > 0) {
    const rows = readReport.gitChannel;
    process.stderr.write(`GIT CHANNEL: ${String(rows.length)} git-channel call(s) resolved outside the world: `
      + rows.slice(0, 5).map((row) => `${row.tool} call${row.seq === null ? '' : ` seq ${String(row.seq)}`} ran `
        + `\`git ${row.verbs.join('; git ')}\``).join('; ')
      + ' — the world has no .git and the campaign root has none, so git climbed above both\n');
  }
  // A judge set of zero is reported on every exit, never gated: the scan being
  // empty is not itself a violation, but `inside: 0` must not be read as a
  // clean boundary when no path was checked (ISSUE-235 item 5).
  if (readReport.judged === 0) {
    process.stderr.write('READ BOUNDARY: 0 paths judged — no tool/call in the session log named an absolute '
      + 'or parent-relative path; the boundary checked nothing on this run\n');
  }
  if (exitCode === EXIT_CODES.green) {
    // The run-level label on the green line is the REMOVAL-QUALIFIED one
    // (`citableAs` above), so a zero-removal run cannot read as a removal
    // measurement in the console. `removals` and `compacted` ride the same
    // line (fifteenth audit items 2 and 4).
    process.stdout.write(passLineFor({
      arm: opts.arm,
      provider: opts.provider,
      results,
      citableAs: citableAsForRun,
      denySkipped,
      verdict: probe.verdict,
      legBScored,
      removals: removals.applied,
      compacted: compaction.count,
    }));
  }
  if (exitCode !== EXIT_CODES.green) {
    const stopName = stoppedAtCheckpoint ? 'stopped-at-checkpoint'
      : stoppedAfterCompactions ? 'stopped-after-compactions'
        : tokenWatch.tokenFired ? 'stopped-by-budget'
          : stoppedOnCompaction ? 'stopped-on-compaction' : null;
    process.stdout.write(`EXIT=${String(exitCode)} (${exitCodeName(exitCode, stopName)})\n`);
    process.exit(exitCode);
  }
}

/**
 * The name a machine log carries beside `EXIT=<n>`; the header's own wording.
 * A stop-on-compaction run reaches the `armFailed` code by a path of its own, so
 * it gets a name of its own: `assertion-failed` on a run that passed every row
 * it could be asked would be a false statement in the artifact.
 */
function exitCodeName(code, stopName = null) {
  if (code === EXIT_CODES.armFailed) return stopName ?? 'assertion-failed';
  return code === EXIT_CODES.readOutOfScope ? 'read-out-of-scope'
    : code === EXIT_CODES.denyPartial ? 'deny-partial'
      : 'green';
}

/**
 * One violation line, with the workspace-only scope named. `describeViolation`
 * covers the campaign and read-only scopes; `outside` is the row the strict
 * rule turns into a violation, and it needs its own words.
 * @param {object} row
 * @returns {string}
 */
function describeReadViolation(row) {
  if (row.scope !== 'outside') return describeViolation(row);
  return `${row.tool} call${row.seq === null ? '' : ` seq ${String(row.seq)}`} named ${row.path} `
    + '(outside the arm world)';
}

/** One-line detail for a failed leg-A check. */
function progressDetail(probe) {
  return `header tools=${String(probe.legA.headerTools)} denied-present=${probe.legA.deniedPresent.join(',') || 'none'}`;
}

// Run only when this file is the process entry point. The guard lets the pure
// measurement gates above be imported by `bench-run.test.mjs` without launching
// a run; `node dev/bench/bench-run.mjs …` still executes `main()` exactly once.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) await main();
