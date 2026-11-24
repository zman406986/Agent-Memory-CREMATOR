#!/usr/bin/env node
/**
 * opencode 2.4.0 — synthetic-message delivery probe (offline).
 *
 * Question: when a mounted plugin calls
 * `session.synthetic({ sessionID, text, resume: false })` at idle, does that
 * text reach the next model request, and in what shape? The answer decides
 * whether the racoons opencode adapter may declare `appendRecords: true` and
 * emit sealed negative facts on this host.
 *
 * The probe is one loopback experiment:
 *   1. a stub provider on 127.0.0.1 speaks the OpenAI-compatible SSE protocol
 *      and records every request body (the only wire witness);
 *   2. a temp world holds an opencode config whose provider points at the stub,
 *      whose `plugins` array mounts a generated probe plugin, and whose
 *      `permissions` deny the `subagent` tool;
 *   3. the session is seeded from `--fixture` when the fixture is compatible
 *      with the installed host, and created by the host otherwise;
 *   4. run 1 sends the first prompt. At idle the plugin calls `synthetic`;
 *   5. runs 2 and 3 are fresh processes on the same session, so the nonce's
 *      survival proves durability across a restart;
 *   6. the journal records every `context` hook's message types, the nonce's
 *      index and role, the synthetic call's return value, and the host store
 *      (`session.context`) before and after.
 *
 * The host surfaces two idle seams. `session.hook('experimental.idle')` is the
 * documented admission seam ("Input admitted by the hook ... runs in the same
 * execution instead of the Session going idle",
 * `node_modules/@opencode/plugin/dist/promise/session.d.ts:155-170`). The
 * `session.idle` *event* is the observation seam the racoons adapter already
 * subscribes to. `--seam` picks which one calls `synthetic`; the other is
 * recorded as an observation only. `--delivery` and `--resume` pick the flags
 * the call carries.
 *
 * Two further modes, both one loopback experiment:
 *
 *   --control    four clean single-prompt scenarios in separate worlds —
 *                (1) no synthetic call, (2) synthetic with `resume:false` and no
 *                `delivery` key, (3) the same with `delivery:"queue"`,
 *                (4) the same with `resume:true` — each counted on the stub log,
 *                so "does an append cost a main request" is a measured delta,
 *                not a comparison across probe runs;
 *   --preflight  seed `--fixture` and run one turn, which is the host's own
 *                verdict on whether the fixture opens and continues.
 *
 * No key, no network beyond 127.0.0.1, no paid call. Usage:
 *
 *   node dev/bench/opencode-synthetic-probe.mjs \
 *     --fixture dev/bench/fixtures/opencode/replay.db
 *
 * Output: a compact JSON summary on stdout and the full record under
 * `scratchpad/launch/<yyyy-mm-dd>-opencode-synthetic-probe/`, which is
 * disposable evidence by the shelf law.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { childEnv, redirectEnv, seedSessionDb } from './opencode-run.mjs';
import { timerDelayRefusal } from '../shared/timer-ms.mjs';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(BENCH_DIR));
const DEFAULT_FIXTURE = join(BENCH_DIR, 'fixtures', 'opencode', 'replay.db');
const SCRATCHPAD = join(REPO_ROOT, 'scratchpad');
const MODEL_ID = 'mock-model';
const MODEL_SELECTOR = `mock/${MODEL_ID}`;
const DUMMY_KEY = 'mock-key-not-real';
const STUB_REPLY = 'PROBE-STUB-REPLY';
const TITLE_MARKER = 'Reply with only the title.';
const SUBAGENT_TOOL = 'subagent';
const SCHEMA = 'cremator-opencode-synthetic-probe/1';
const CONTROL_SCHEMA = 'cremator-opencode-synthetic-control/1';
/** The host's session brand: `ses_` then 26 alphanumerics. */
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]{26}$/u;
/** The host's message brand: `msg_` then 26 alphanumerics. */
const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9]{26}$/u;
/** The `workspace` columns the installed host queries, in its own order. */
const WORKSPACE_COLUMNS = Object.freeze(['id', 'provider', 'binding', 'created_at', 'last_used_at']);

function refuse(message) {
  process.stderr.write(`opencode-synthetic-probe.mjs: ${message}\n`);
  process.exit(2);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** One JSON object per line, never rewritten; the journal is append-only. */
function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { kind: 'unparsed-line', line };
      }
    });
}

/* ------------------------------------------------------------------ arguments */

const USAGE = `usage: opencode-synthetic-probe.mjs --fixture <opencode.db> [flags]
  --fixture <path>      the source database (default: dev/bench/fixtures/opencode/replay.db)
  --opencode-bin <path> the 2.4.0 binary (default: resolve from PATH / npm root -g)
  --evidence <dir>      evidence root (default: scratchpad/launch/<date>-opencode-synthetic-probe)
  --seam <hook|event>   the idle seam that calls synthetic (default: hook)
  --resume <true|false> the synthetic call's resume flag (default: false)
  --delivery <steer|queue|none> the synthetic call's delivery; none omits the key (default: steer)
  --runs <2|3|4|5>      measured runs on one session (default: 3)
  --timeout-ms <n>      per-run kill timer (default: 120000)
  --control             run the four single-prompt cost scenarios and report the counts
  --preflight           seed --fixture and run one turn; report the host's verdict
  --log-level <level>   pass --log-level/--print-logs to every run (diagnosis only)
  --json                print the result JSON only
  --help                print this text`;

/**
 * Parse the probe's own argv. Pure, so the test can exercise the refusal
 * paths without spawning anything.
 * @param {string[]} argv
 * @returns {{fixture: string, opencodeBin: string|null, evidence: string,
 *   seam: 'hook'|'event', resume: boolean, delivery: 'steer'|'queue'|'none',
 *   runs: number, timeoutMs: number, control: boolean, preflight: boolean,
 *   logLevel: string|null, json: boolean, help: boolean}}
 */
export function parseProbeArgs(argv) {
  const opts = {
    fixture: DEFAULT_FIXTURE,
    opencodeBin: null,
    evidence: join(SCRATCHPAD, 'launch', `${today()}-opencode-synthetic-probe`),
    seam: 'hook',
    resume: false,
    delivery: 'steer',
    runs: 3,
    timeoutMs: 120_000,
    control: false,
    preflight: false,
    logLevel: null,
    json: false,
    help: false,
  };
  const take = (index, flag) => {
    if (index + 1 >= argv.length) throw new TypeError(`${flag} needs a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') { opts.fixture = take(index, arg); index += 1; }
    else if (arg === '--opencode-bin') { opts.opencodeBin = take(index, arg); index += 1; }
    else if (arg === '--evidence') { opts.evidence = take(index, arg); index += 1; }
    else if (arg === '--seam') {
      const value = take(index, arg);
      if (value !== 'hook' && value !== 'event') throw new TypeError(`--seam must be hook or event (got ${JSON.stringify(value)})`);
      opts.seam = value;
      index += 1;
    } else if (arg === '--resume') {
      const value = take(index, arg);
      if (value !== 'true' && value !== 'false') throw new TypeError(`--resume must be true or false (got ${JSON.stringify(value)})`);
      opts.resume = value === 'true';
      index += 1;
    } else if (arg === '--delivery') {
      const value = take(index, arg);
      if (value !== 'steer' && value !== 'queue' && value !== 'none') {
        throw new TypeError(`--delivery must be steer, queue or none (got ${JSON.stringify(value)})`);
      }
      opts.delivery = value;
      index += 1;
    } else if (arg === '--runs') {
      const value = Number(take(index, arg));
      if (!Number.isInteger(value) || value < 2 || value > 5) throw new TypeError('--runs must be 2..5');
      opts.runs = value;
      index += 1;
    } else if (arg === '--timeout-ms') {
      const value = Number(take(index, arg));
      if (!Number.isInteger(value) || value < 10_000) throw new TypeError('--timeout-ms must be an integer >= 10000');
      const tooLong = timerDelayRefusal(value, '--timeout-ms');
      if (tooLong !== null) throw new TypeError(tooLong);
      opts.timeoutMs = value;
      index += 1;
    } else if (arg === '--control') opts.control = true;
    else if (arg === '--preflight') opts.preflight = true;
    else if (arg === '--log-level') {
      const value = take(index, arg);
      if (!['all', 'trace', 'debug', 'info', 'warn', 'warning', 'error', 'fatal', 'none'].includes(value)) {
        throw new TypeError(`--log-level must be a host level (got ${JSON.stringify(value)})`);
      }
      opts.logLevel = value;
      index += 1;
    } else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new TypeError(`unknown argument ${JSON.stringify(arg)}`);
  }
  return opts;
}

/* ------------------------------------------------------------------ messages */

/**
 * One message's text, for either shape the probe sees: the host's
 * `Message` (`content: ContentPart[]`, `@opencode/ai/dist/schema/messages.d.ts`)
 * or the OpenAI-compatible wire message (`content: string | part[]`).
 * @param {unknown} message
 * @returns {string}
 */
export function messageText(message) {
  if (message === null || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part !== null && typeof part === 'object'
      && (part.type === undefined || part.type === 'text')
      && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * The first message carrying the nonce, with its array index and role.
 * `index` is -1 and `message` null when the nonce is absent, so a caller can
 * distinguish "not carried" from "carried at the head".
 * @param {unknown} messages
 * @param {string} nonce
 * @returns {{index: number, role: string|null, text: string|null, message: unknown}}
 */
export function nonceInMessages(messages, nonce) {
  if (!Array.isArray(messages) || typeof nonce !== 'string' || nonce.length === 0) {
    return { index: -1, role: null, text: null, message: null };
  }
  for (const [index, message] of messages.entries()) {
    const text = messageText(message);
    if (text.includes(nonce)) {
      return {
        index,
        role: typeof message?.role === 'string' ? message.role : null,
        text,
        message,
      };
    }
  }
  return { index: -1, role: null, text: null, message: null };
}

/** A JSON-safe copy; a value that cannot serialize is reported, not thrown. */
export function jsonSafe(value) {
  try {
    return { ok: true, value: JSON.parse(JSON.stringify(value)) };
  } catch (error) {
    return { ok: false, value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The message types and roles in an array, as one compact row. */
export function messageShape(messages) {
  if (!Array.isArray(messages)) return { count: 0, roles: [], types: [] };
  return {
    count: messages.length,
    roles: messages.map((message) => (typeof message?.role === 'string' ? message.role : null)),
    types: messages.map((message) => (typeof message?.type === 'string' ? message.type : null)),
  };
}

/* ------------------------------------------------------------------ the stub */

/**
 * Start the loopback stub. Every chat body is recorded verbatim before it is
 * answered, so the wire evidence is the request, not a receipt derived from
 * it. Binding is 127.0.0.1 only; port 0 lets the OS choose.
 * @param {{logPath: string, replyText?: string}} options
 * @returns {Promise<{port: number, url: string, close: () => Promise<void>,
 *   rows: () => object[], count: () => number}>}
 */
export async function startStub({ logPath, replyText = STUB_REPLY }) {
  let seq = 0;
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      seq += 1;
      let body = null;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const record = {
        seq,
        atMs: Date.now(),
        method: request.method,
        url: request.url,
        bodyBytes: Buffer.byteLength(raw, 'utf8'),
        body,
        bodyParseError: body === null && raw.length > 0,
      };
      appendFileSync(logPath, `${JSON.stringify(record)}\n`);
      if (request.method === 'GET' && request.url.includes('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL_ID, object: 'model' }] }));
        return;
      }
      if (request.method === 'POST' && request.url.includes('/chat/completions')) {
        const id = `chatcmpl-probe-${seq}`;
        const created = 1_700_000_000 + seq;
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const frame = (payload) => response.write(`data: ${JSON.stringify({ model: MODEL_ID, ...payload })}\n\n`);
        frame({
          id, object: 'chat.completion.chunk', created,
          choices: [{ index: 0, delta: { role: 'assistant', content: replyText }, finish_reason: null }],
        });
        frame({
          id, object: 'chat.completion.chunk', created,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        frame({
          id, object: 'chat.completion', created,
          choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1_000, completion_tokens: 5, total_tokens: 1_005 },
        });
        response.write('data: [DONE]\n\n');
        response.end();
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `no route ${request.method} ${request.url}` } }));
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
    rows: () => readJsonLines(logPath),
    count: () => seq,
  };
}

/* ------------------------------------------------------------------ the world */

/**
 * The composed opencode config. One provider points at the loopback stub, one
 * plugin is the probe, and `permissions` denies the subagent tool by the
 * product's own constant. No `compaction` key is written.
 * @param {{baseURL: string, pluginDir: string, subagentTool?: string}} input
 * @returns {object}
 */
export function composeProbeConfig({ baseURL, pluginDir, subagentTool = SUBAGENT_TOOL }) {
  return {
    $schema: 'https://opencode.ai/config.json',
    permissions: [{ action: subagentTool, resource: '*', effect: 'deny' }],
    providers: {
      mock: {
        name: 'mock',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL, apiKey: DUMMY_KEY },
        models: { [MODEL_ID]: { name: MODEL_ID } },
      },
    },
    model: MODEL_SELECTOR,
    plugins: [{ package: pathToFileURL(pluginDir).href }],
  };
}

/**
 * The probe plugin's source. The host's loader requires the definition as the
 * module's **default** export (`Plugin` in `@opencode/plugin/dist/promise/plugin.d.ts`);
 * a named `setup` export is refused with
 * `Plugin must export a default definition with an id and an effect or setup function`.
 *
 * The plugin never throws into the host and never returns a promise from the
 * `context` hook: observation must not change the request. The idle call is
 * guarded, because an unguarded synthetic at idle is admitted and runs a model
 * turn, which goes idle again — an infinite loop, observed on this host.
 * @returns {string}
 */
export function probePluginSource() {
  return `import { appendFileSync } from 'node:fs';

const JOURNAL = process.env.CREMATOR_PROBE_JOURNAL;
const NONCE = process.env.CREMATOR_PROBE_NONCE;
const ARM = process.env.CREMATOR_PROBE_ARM === '1';
const SEAM = process.env.CREMATOR_PROBE_SEAM || 'hook';
const RESUME = process.env.CREMATOR_PROBE_RESUME === 'true';
const DELIVERY = process.env.CREMATOR_PROBE_DELIVERY || 'steer';
let line = 0;

function write(record) {
  try {
    appendFileSync(JOURNAL, JSON.stringify({ line: line++, pid: process.pid, at: Date.now(), ...record }) + '\\n');
  } catch { /* the host must not see a journal failure */ }
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (
    (part?.type === undefined || part?.type === 'text') && typeof part?.text === 'string'
      ? part.text : '')).join('');
}

function safe(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (error) {
    return { unserializable: String(error?.message ?? error) };
  }
}

function storeSummary(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const parsed = (row) => {
    try { return JSON.parse(row.data); } catch { return row.data; }
  };
  return {
    count: rows.length,
    types: rows.map((row) => row.type ?? null),
    synthetic: rows.filter((row) => row.type === 'synthetic').map((row) => ({
      id: row.id, type: row.type, seq: row.seq ?? null, time: row.time ?? null,
      text: row.text ?? parsed(row)?.text ?? null,
      description: row.description ?? parsed(row)?.description ?? null,
      raw: safe(row),
    })),
    nonce: rows.filter((row) => JSON.stringify(row).includes(NONCE)).map((row) => safe(row)),
  };
}

export default {
  id: 'racoons-synthetic-probe',
  setup: async (context) => {
    const session = context.session;
    write({
      kind: 'setup',
      sessionKeys: session ? Object.keys(session) : [],
      hasSynthetic: typeof session?.synthetic,
      hasContext: typeof session?.context,
      hasHook: typeof session?.hook,
      hasMessage: typeof session?.message,
      hasInbox: typeof session?.inbox,
      hasSubscribe: typeof context.event?.subscribe,
      arm: ARM,
      seam: SEAM,
      resume: RESUME,
      delivery: DELIVERY,
    });

    try {
      await session.hook('context', (input) => {
        try {
          const messages = Array.isArray(input?.messages) ? input.messages : [];
          const hit = messages.findIndex((message) => textOf(message).includes(NONCE));
          write({
            kind: 'context',
            sessionID: input?.sessionID ?? null,
            agent: input?.agent ?? null,
            model: input?.model ?? null,
            count: messages.length,
            roles: messages.map((message) => message?.role ?? null),
            toolCount: input?.tools === undefined ? null : Object.keys(input.tools).length,
            nonceIndex: hit,
            nonceRole: hit >= 0 ? messages[hit]?.role ?? null : null,
            nonceText: hit >= 0 ? textOf(messages[hit]) : null,
            nonceMessage: hit >= 0 ? safe(messages[hit]) : null,
            previous: hit > 0 ? safe(messages[hit - 1]) : null,
            next: hit >= 0 && hit + 1 < messages.length ? safe(messages[hit + 1]) : null,
          });
        } catch (error) {
          write({ kind: 'context-error', message: String(error?.message ?? error) });
        }
      });
      write({ kind: 'hook-registered', name: 'context' });
    } catch (error) {
      write({ kind: 'hook-error', name: 'context', message: String(error?.message ?? error) });
    }

    let admitted = false;
    async function admit(source, sessionID) {
      if (admitted) { write({ kind: 'idle-skip', source, reason: 'already-admitted-in-this-process' }); return; }
      admitted = true;
      if (!ARM) { write({ kind: 'idle-noop', source, sessionID, reason: 'arm=0' }); return; }
      write({ kind: 'idle', source, sessionID });
      let before = null;
      try {
        before = await session.context({ sessionID });
        write({ kind: 'store-before', source: 'session.context', sessionID, ...storeSummary(before) });
      } catch (error) {
        write({ kind: 'store-before-error', sessionID, message: String(error?.message ?? error) });
      }
      try {
        // The control's scenario 2 sends the call with no delivery key at all
        // (sessionID, text, resume only). Any other value sends the flag.
        const args = {
          sessionID,
          text: NONCE,
          description: 'racoons synthetic probe',
          resume: RESUME,
        };
        if (DELIVERY !== 'none') args.delivery = DELIVERY;
        write({ kind: 'synthetic-call', args: safe(args) });
        const returned = await session.synthetic(args);
        const safeReturn = safe(returned);
        write({
          kind: 'synthetic-return',
          sessionID,
          keys: returned !== null && typeof returned === 'object' ? Object.keys(returned) : [],
          json: safeReturn,
          time: safe(returned?.time ?? null),
          delivery: returned?.delivery ?? null,
          type: returned?.type ?? null,
        });
      } catch (error) {
        write({
          kind: 'synthetic-error',
          sessionID,
          name: error?.name ?? null,
          message: String(error?.message ?? error),
          stack: typeof error?.stack === 'string' ? error.stack : null,
        });
      }
      try {
        const after = await session.context({ sessionID });
        write({ kind: 'store-after', source: 'session.context', sessionID, ...storeSummary(after) });
      } catch (error) {
        write({ kind: 'store-after-error', sessionID, message: String(error?.message ?? error) });
      }
    }

    if (SEAM === 'hook') {
      try {
        await session.hook('experimental.idle', async (input) => {
          write({ kind: 'idle-hook-fired', sessionID: input?.sessionID ?? null, background: safe(input?.background ?? null) });
          if (typeof input?.sessionID === 'string') await admit('hook', input.sessionID);
        });
        write({ kind: 'hook-registered', name: 'experimental.idle' });
      } catch (error) {
        write({ kind: 'hook-error', name: 'experimental.idle', message: String(error?.message ?? error) });
      }
      try {
        await session.hook('session.idle', async (input) => {
          write({ kind: 'idle-hook-fired', name: 'session.idle', sessionID: input?.sessionID ?? null });
        });
        write({ kind: 'hook-registered', name: 'session.idle' });
      } catch (error) {
        write({ kind: 'hook-error', name: 'session.idle', message: String(error?.message ?? error) });
      }
    }

    let iterator = null;
    try {
      iterator = context.event.subscribe({ types: ['session.idle'] })[Symbol.asyncIterator]();
      (async () => {
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            const value = next.value;
            write({ kind: 'event', type: value?.type ?? null, sessionID: value?.data?.sessionID ?? null });
            if (SEAM === 'event' && value?.type === 'session.idle' && typeof value?.data?.sessionID === 'string') {
              await admit('event', value.data.sessionID);
            }
          }
        } catch (error) {
          write({ kind: 'event-error', message: String(error?.message ?? error) });
        }
      })();
      write({ kind: 'event-subscribed' });
    } catch (error) {
      write({ kind: 'event-subscribe-error', message: String(error?.message ?? error) });
    }

    return async () => {
      write({ kind: 'cleanup' });
      try { await iterator?.return?.(); } catch { /* already closed */ }
    };
  },
};
`;
}

/* ------------------------------------------------------------------ fixture */

/**
 * Point the world's seeded copy at a directory that exists on this machine. A
 * committed fixture must not name a real path, so it carries a synthetic one;
 * the host refuses a session whose location is missing (`Location not found:
 * ...`). The rewrite happens in the world's copy only, never in the fixture,
 * and the preflight result records both ends.
 * @param {string} databasePath
 * @param {string} sessionId
 * @param {string} directory
 */
export function relocateSeededSession(databasePath, sessionId, directory) {
  const db = new DatabaseSync(databasePath);
  try {
    const session = db.prepare('SELECT project_id, directory FROM session_v2 WHERE id = ?')
      .get(sessionId);
    if (session === undefined) {
      return { ok: false, refused: `no session_v2 row ${sessionId} in the seeded copy` };
    }
    const from = String(session.directory);
    const projectId = String(session.project_id);
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE session_v2 SET directory = ? WHERE id = ?').run(directory, sessionId);
      db.prepare('UPDATE project SET worktree = ? WHERE id = ?').run(directory, projectId);
      db.prepare('UPDATE project_directory SET directory = ? WHERE project_id = ?')
        .run(directory, projectId);
      db.prepare('UPDATE worktree SET directory = ? WHERE project_id = ?').run(directory, projectId);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* the transaction may already be closed */ }
      throw error;
    }
    return { ok: true, from, to: directory };
  } catch (error) {
    return { ok: false, refused: error instanceof Error ? error.message : String(error) };
  } finally {
    db.close();
  }
}

/**
 * What the fixture can seed into the installed host, decided from the file
 * itself. The host's refusals are checked by name — the session id brand
 * (`ses_` + 26 alphanumerics), the message id brand (`msg_` + 26), the `model`
 * column's JSON `{id, providerID}` shape, and the `workspace` table with the
 * host's columns — because each was a real refusal from the installed binary,
 * not a probe preference. A fixture that passes all of them is seeded with
 * `seedSessionDb`; any other is reported by reason and the run creates its
 * session instead.
 * @param {string} fixturePath
 * @returns {{ok: boolean, path: string, sha256: string|null, sessionId: string|null,
 *   sessionCount: number, messageCount: number, version: string|null,
 *   model: string|null, tables: string[], workspaceColumns: string[],
 *   messageIdsBranded: number, messageIdsTotal: number, refusals: string[]}}
 */
export function inspectFixture(fixturePath) {
  const result = {
    ok: false,
    path: fixturePath,
    sha256: null,
    sessionId: null,
    sessionCount: 0,
    messageCount: 0,
    version: null,
    model: null,
    tables: [],
    workspaceColumns: [],
    messageIdsBranded: 0,
    messageIdsTotal: 0,
    refusals: [],
  };
  if (!existsSync(fixturePath)) {
    result.refusals.push(`no database at ${fixturePath}`);
    return result;
  }
  result.sha256 = createHash('sha256').update(readFileSync(fixturePath)).digest('hex');
  let db = null;
  try {
    db = new DatabaseSync(fixturePath, { readOnly: true });
    result.tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all().map((row) => String(row.name));
    if (!result.tables.includes('session_v2')) {
      result.refusals.push('the fixture has no session_v2 table; it is not a 2.4.0 host database');
      return result;
    }
    const sessions = db.prepare('SELECT * FROM session_v2 ORDER BY time_created').all();
    result.sessionCount = sessions.length;
    if (sessions.length !== 1) {
      result.refusals.push(`the fixture holds ${sessions.length} sessions; the probe needs exactly one`);
      return result;
    }
    const session = sessions[0];
    result.sessionId = String(session.id);
    result.version = session.version === undefined ? null : String(session.version);
    result.model = session.model === undefined ? null : String(session.model);
    result.messageCount = result.tables.includes('session_message')
      ? Number(db.prepare('SELECT count(*) AS n FROM session_message WHERE session_id = ?')
        .get(result.sessionId).n)
      : 0;
    if (!SESSION_ID_PATTERN.test(result.sessionId)) {
      result.refusals.push(`the fixture session id ${JSON.stringify(result.sessionId)} is not `
        + 'ses_ + 26 alphanumerics; the host\'s --session brand refuses it '
        + '(Expected a string starting with "ses")');
    }
    if (result.tables.includes('session_message')) {
      const ids = db.prepare('SELECT id FROM session_message WHERE session_id = ?')
        .all(result.sessionId).map((row) => String(row.id));
      result.messageIdsBranded = ids.filter((id) => MESSAGE_ID_PATTERN.test(id)).length;
      result.messageIdsTotal = ids.length;
      if (result.messageIdsBranded !== result.messageIdsTotal) {
        result.refusals.push(`${result.messageIdsTotal - result.messageIdsBranded} of `
          + `${result.messageIdsTotal} message id(s) are not msg_ + 26 alphanumerics; the host `
          + 'decodes every stored message through that brand '
          + '(SchemaError: Expected a string starting with "msg_")');
      }
    }
    try {
      const model = JSON.parse(result.model ?? 'null');
      if (model === null || typeof model !== 'object' || typeof model.id !== 'string'
        || typeof model.providerID !== 'string') {
        result.refusals.push(`the fixture session model ${JSON.stringify(result.model)} is not `
          + '{"id":...,"providerID":...}; the host parses that column as JSON');
      }
    } catch {
      result.refusals.push(`the fixture session model ${JSON.stringify(result.model)} is not JSON; `
        + 'the host parses that column as JSON');
    }
    if (!result.tables.includes('workspace')) {
      result.refusals.push('the fixture has no workspace table; the installed host runs '
        + '20260410174513_workspace-name over it and fails with "no such table: workspace"');
    } else {
      result.workspaceColumns = db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
        .all('workspace').map((row) => String(row.name));
      const missing = WORKSPACE_COLUMNS.filter((column) => !result.workspaceColumns.includes(column));
      if (missing.length > 0) {
        result.refusals.push(`the fixture workspace table is missing column(s) `
          + `${missing.join(', ')}; the host queries them`);
      }
    }
    result.ok = result.refusals.length === 0;
    return result;
  } catch (error) {
    result.refusals.push(`the fixture cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * The host store's synthetic rows and inbox rows, read from the SQLite file the
 * child wrote. This is the post-run cross-check of `session.context`: the store
 * is on disk, so a row that survived the process is visible after it exits.
 * @param {string} databasePath
 * @param {string} sessionId
 * @returns {{synthetic: object[], inbox: object[], tables: string[]}}
 */
export function hostStoreRows(databasePath, sessionId) {
  const empty = { synthetic: [], inbox: [], tables: [] };
  if (!existsSync(databasePath)) return empty;
  let db = null;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all().map((row) => String(row.name));
    const synthetic = tables.includes('session_message')
      ? db.prepare("SELECT id, session_id, type, seq, time_created, time_updated, data "
        + "FROM session_message WHERE session_id = ? AND type = 'synthetic' ORDER BY seq")
        .all(sessionId)
        .map((row) => ({ ...row, data: (() => { try { return JSON.parse(row.data); } catch { return row.data; } })() }))
      : [];
    const inbox = tables.includes('session_inbox')
      ? db.prepare('SELECT id, session_id, type, payload, delivery, enqueued_seq, time_created '
        + 'FROM session_inbox WHERE session_id = ? ORDER BY enqueued_seq').all(sessionId)
        .map((row) => ({ ...row, payload: (() => { try { return JSON.parse(row.payload); } catch { return row.payload; } })() }))
      : [];
    return { synthetic, inbox, tables };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * The session ids in a host database. Used after run 1 to prove the host
 * created exactly the id the probe asked for, not a second session beside it.
 * @param {string} databasePath
 * @returns {string[]}
 */
export function sessionIds(databasePath) {
  if (!existsSync(databasePath)) return [];
  let db = null;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const exists = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'").get().n;
    if (Number(exists) === 0) return [];
    return db.prepare('SELECT id FROM session_v2 ORDER BY time_created').all().map((row) => String(row.id));
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/* ------------------------------------------------------------------ analysis */

/**
 * One stub row's shape. A main request carries a non-empty tool table; a
 * tool-less chat that carries the host's title prompt is the title lane; any
 * other chat is reported as `other` rather than guessed at.
 * @param {{method: string|null, url: string|null, body: unknown}} row
 * @returns {'models'|'main'|'title'|'other'}
 */
export function classifyStubRequest(row) {
  const method = row?.method ?? null;
  const url = row?.url ?? '';
  if (method === 'GET' && url.includes('/models')) return 'models';
  const body = row?.body;
  if (method !== 'POST' || !url.includes('/chat/completions')) return 'other';
  if (Array.isArray(body?.tools) && body.tools.length > 0) return 'main';
  const text = JSON.stringify(body ?? {});
  return text.includes(TITLE_MARKER) ? 'title' : 'other';
}

/**
 * One run's request rows, split by lane and nonce. `nonceHits` names the row,
 * the message index and the role, which is the wire evidence the question asks
 * for.
 * @param {object[]} rows the stub log rows inside this run's window
 * @param {string} nonce
 */
export function summarizeRequests(rows, nonce) {
  const list = Array.isArray(rows) ? rows : [];
  const byLane = { main: 0, title: 0, other: 0, models: 0 };
  const nonceHits = [];
  const mainRows = [];
  for (const row of list) {
    const lane = classifyStubRequest(row);
    byLane[lane] += 1;
    const messages = Array.isArray(row?.body?.messages) ? row.body.messages : [];
    const hit = nonceInMessages(messages, nonce);
    if (lane === 'main') mainRows.push(row.seq);
    if (hit.index >= 0) {
      nonceHits.push({
        seq: row.seq,
        lane,
        index: hit.index,
        role: hit.role,
        text: hit.text,
        message: hit.message,
        messageCount: messages.length,
        roles: messages.map((message) => message?.role ?? null),
      });
    }
  }
  return {
    total: list.length,
    ...byLane,
    mainSeqs: mainRows,
    nonceHits,
    firstMainSeq: mainRows.length > 0 ? mainRows[0] : null,
  };
}

/**
 * Every main request in a run, in wire order, with the facts the cost question
 * needs: whether it carries the user prompt and whether it carries the nonce.
 * The message array is recorded for the requests that carry the nonce — that
 * array *is* the body the question asks for; the tool table is identical across
 * them, so only its length is kept.
 * @param {object[]} rows
 * @param {string} nonce
 * @param {string|null} prompt
 */
export function mainRequestsDetail(rows, nonce, prompt = null) {
  const list = Array.isArray(rows) ? rows : [];
  const promptText = typeof prompt === 'string' && prompt.length > 0 ? prompt : null;
  const details = [];
  for (const row of list) {
    if (classifyStubRequest(row) !== 'main') continue;
    const messages = Array.isArray(row?.body?.messages) ? row.body.messages : [];
    const hit = nonceInMessages(messages, nonce);
    const detail = {
      seq: row.seq,
      atMs: row.atMs ?? null,
      messageCount: messages.length,
      roles: messages.map((message) => message?.role ?? null),
      toolCount: Array.isArray(row?.body?.tools) ? row.body.tools.length : 0,
      carriesNonce: hit.index >= 0,
      carriesPrompt: promptText === null
        ? null
        : messages.some((message) => messageText(message).includes(promptText)),
      nonceIndex: hit.index,
      nonceRole: hit.role,
    };
    if (hit.index >= 0) detail.bodyMessages = jsonSafe(messages).value;
    details.push(detail);
  }
  return details;
}

/**
 * When the synthetic turn ran, relative to the user prompt's turn, for one
 * scenario's main requests. `after` means the request carrying the nonce has a
 * higher stub sequence than the request carrying the prompt; the append's turn
 * therefore ran after the prompt's turn completed.
 * @param {object[]} details from `mainRequestsDetail`
 * @returns {'after'|'before'|'same-request'|'no-synthetic-turn'|'no-prompt-turn'|'unknown'}
 */
export function syntheticTurnOrder(details) {
  const list = Array.isArray(details) ? details : [];
  const promptTurn = list.find((row) => row.carriesPrompt === true && row.carriesNonce !== true) ?? null;
  const nonceTurn = list.find((row) => row.carriesNonce === true) ?? null;
  if (nonceTurn === null) return 'no-synthetic-turn';
  if (promptTurn === null) return 'no-prompt-turn';
  if (nonceTurn.seq === promptTurn.seq) return 'same-request';
  return nonceTurn.seq > promptTurn.seq ? 'after' : 'before';
}

/**
 * The four clean scenarios. Each sends ONE user prompt in a fresh world; the
 * only difference is the synthetic call at idle. Scenario 1 is the baseline the
 * other three are measured against, which is what makes the delta attributable
 * to the append instead of to a different probe run.
 */
export const CONTROL_SCENARIOS = Object.freeze([
  { id: 1, label: 'one-prompt-no-synthetic', arm: false, resume: false, delivery: 'none' },
  { id: 2, label: 'one-prompt-synthetic-resume-false', arm: true, resume: false, delivery: 'none' },
  { id: 3, label: 'one-prompt-synthetic-delivery-queue', arm: true, resume: false, delivery: 'queue' },
  { id: 4, label: 'one-prompt-synthetic-resume-true', arm: true, resume: true, delivery: 'none' },
]);

/**
 * The control's verdict, over the four scenario records. Pure. A count above
 * the baseline is an extra main request, and the extra one is the synthetic
 * turn when the nonce rides it.
 * @param {object[]} scenarios one record per `CONTROL_SCENARIOS` entry
 */
export function decideControl(scenarios) {
  const list = Array.isArray(scenarios) ? scenarios : [];
  const at = (id) => list.find((row) => row.id === id) ?? null;
  const count = (id) => (at(id) === null ? null : at(id).mainRequests);
  const baseline = count(1);
  const extra = (value) => (baseline === null || value === null ? null : value - baseline);
  const counts = {
    baseline: baseline,
    resumeFalse: count(2),
    queue: count(3),
    resumeTrue: count(4),
  };
  const extraMainRequests = {
    resumeFalse: extra(counts.resumeFalse),
    queue: extra(counts.queue),
    resumeTrue: extra(counts.resumeTrue),
  };
  return {
    counts,
    extraMainRequests,
    appendCausesModelTurn: extraMainRequests.resumeFalse !== null
      ? extraMainRequests.resumeFalse > 0
      : null,
    queueDeliveryCausesModelTurn: extraMainRequests.queue !== null
      ? extraMainRequests.queue > 0
      : null,
    resumeTrueCausesModelTurn: extraMainRequests.resumeTrue !== null
      ? extraMainRequests.resumeTrue > 0
      : null,
    appendCostsExactlyOneMainRequest: extraMainRequests.resumeFalse === 1,
    syntheticTurnOrder: {
      resumeFalse: at(2)?.syntheticTurnOrder ?? null,
      queue: at(3)?.syntheticTurnOrder ?? null,
      resumeTrue: at(4)?.syntheticTurnOrder ?? null,
    },
  };
}

/**
 * The probe's verdict over the journal, the run windows and the on-disk store.
 * Pure: every input is data the caller already collected.
 * @param {{journal: object[], runs: object[], nonce: string, resume: boolean,
 *   delivery: 'steer'|'queue', seam: string, store: object}}
 */
export function analyzeProbe({ journal, runs, nonce, resume, delivery = 'steer', seam, store }) {
  const lines = Array.isArray(journal) ? journal : [];
  const contextLines = lines.filter((row) => row.kind === 'context');
  const syntheticReturns = lines.filter((row) => row.kind === 'synthetic-return');
  const syntheticErrors = lines.filter((row) => row.kind === 'synthetic-error');
  const hookErrors = lines.filter((row) => row.kind === 'hook-error');
  const idleLines = lines.filter((row) => row.kind === 'idle');
  const storeBefore = lines.filter((row) => row.kind === 'store-before');
  const storeAfter = lines.filter((row) => row.kind === 'store-after');
  const withNonce = contextLines.filter((row) => Number(row.nonceIndex) >= 0);
  const firstHit = withNonce.length > 0 ? withNonce[0] : null;
  const latest = withNonce.length > 0 ? withNonce[withNonce.length - 1] : null;
  const eventLines = lines.filter((row) => row.kind === 'event');
  const first = Array.isArray(runs) ? runs[0] : null;
  const later = Array.isArray(runs) ? runs.slice(1) : [];
  const syntheticRows = Array.isArray(store?.synthetic) ? store.synthetic : [];
  return {
    seam,
    resume,
    delivery,
    nonce,
    nonceInContextHook: firstHit !== null,
    contextHook: firstHit === null ? null : {
      line: firstHit.line ?? null,
      pid: firstHit.pid ?? null,
      sessionID: firstHit.sessionID ?? null,
      count: firstHit.count ?? null,
      roles: firstHit.roles ?? null,
      nonceIndex: firstHit.nonceIndex,
      nonceRole: firstHit.nonceRole ?? null,
      nonceText: firstHit.nonceText ?? null,
      nonceMessage: firstHit.nonceMessage ?? null,
      previous: firstHit.previous ?? null,
      next: firstHit.next ?? null,
      toolCount: firstHit.toolCount ?? null,
    },
    lastNonceContext: latest === null ? null : {
      line: latest.line ?? null,
      pid: latest.pid ?? null,
      count: latest.count ?? null,
      nonceIndex: latest.nonceIndex,
      nonceRole: latest.nonceRole ?? null,
    },
    contextHookCalls: contextLines.length,
    eventLines: eventLines.length,
    syntheticReturn: syntheticReturns.length > 0 ? syntheticReturns[syntheticReturns.length - 1] : null,
    syntheticErrors,
    hookErrors,
    idleCalls: idleLines.length,
    storeBefore: storeBefore.length > 0 ? storeBefore[0] : null,
    storeAfter: storeAfter.length > 0 ? storeAfter[storeAfter.length - 1] : null,
    wire: {
      run1NonceHits: first?.requests?.nonceHits ?? [],
      run1MainRequests: first?.requests?.main ?? null,
      run1TitleRequests: first?.requests?.title ?? null,
      run1TotalChatRequests: first === null ? null : first.requests.main + first.requests.title + first.requests.other,
      extraMainRequestAfterIdle: first === null ? null : first.requests.main > 1,
      // A run carries one prompt, so every main request beyond the first is
      // the append's own turn. `--control` scenario 1 is the measured baseline
      // that makes this a delta instead of a guess.
      run1MainRequestsBeyondOnePrompt: first === null ? null : first.requests.main - 1,
      laterRunsFirstMainCarriesNonce: later.map((run) => {
        const hit = run.requests.nonceHits.find((row) => row.seq === run.requests.firstMainSeq);
        return { run: run.index, firstMainSeq: run.requests.firstMainSeq, carried: hit !== undefined, hit: hit ?? null };
      }),
    },
    durability: {
      syntheticStoreRows: syntheticRows,
      run2CarriesNonce: later.length > 0
        ? later[0].requests.nonceHits.some((row) => row.seq === later[0].requests.firstMainSeq)
        : null,
      run3CarriesNonce: later.length > 1
        ? later[1].requests.nonceHits.some((row) => row.seq === later[1].requests.firstMainSeq)
        : null,
    },
  };
}

/* ------------------------------------------------------------------ harness */

function resolveOpencodeBin(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) {
    if (!existsSync(explicit)) refuse(`--opencode-bin ${explicit} does not exist`);
    return resolve(explicit);
  }
  const exeName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const candidates = [join(dirname(process.execPath), 'node_modules', '@opencode', 'cli', 'bin', exeName)];
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir.length > 0) candidates.push(join(dir, exeName));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  if (process.platform === 'win32') {
    const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true });
    const globalRoot = root.status === 0 ? (root.stdout ?? '').trim() : '';
    if (globalRoot.length > 0) {
      const candidate = join(globalRoot, '@opencode', 'cli', 'bin', exeName);
      if (existsSync(candidate)) return resolve(candidate);
    }
  }
  refuse('cannot resolve the opencode binary; pass --opencode-bin <path>');
  return '';
}

/** Spawn one opencode run, capture both streams, enforce the kill timer. */
function launchRun({ bin, task, sessionId, cwd, env, timeoutMs, logLevel = null }) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    const argv = [
      '--standalone', 'run', task,
      '--session', sessionId,
      '--model', MODEL_SELECTOR,
      '--format', 'json',
      '--auto',
    ];
    if (typeof logLevel === 'string' && logLevel.length > 0) {
      argv.push('--log-level', logLevel, '--print-logs');
    }
    const child = spawn(bin, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch { /* the close event still resolves the run */ }
    }, timeoutMs);
    timer.unref?.();
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr, durationMs: Date.now() - startedAt, timedOut: false });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveRun({ code: null, signal: null, stdout, stderr: `${stderr}${String(error)}`, durationMs: Date.now() - startedAt, timedOut: false });
    });
  });
}

/* ------------------------------------------------------------------ world files */

/**
 * The host's loader requires a directory target: a plugin file is warned about
 * and skipped. The definition is the module's default export.
 * @param {string} pluginDir
 */
export function writeProbePlugin(pluginDir) {
  writeFileSync(join(pluginDir, 'index.js'), probePluginSource());
  writeFileSync(join(pluginDir, 'package.json'), `${JSON.stringify({
    name: 'racoons-synthetic-probe',
    version: '0.0.0',
    private: true,
    type: 'module',
    main: './index.js',
    exports: { '.': './index.js' },
  }, null, 2)}\n`);
}

/** Write the composed config where the child's redirected XDG_CONFIG_HOME reads it. */
export function writeProbeConfig(configDir, baseURL, pluginDir) {
  writeFileSync(join(configDir, 'opencode.json'), `${JSON.stringify(composeProbeConfig({
    baseURL,
    pluginDir,
  }), null, 2)}\n`);
}

/**
 * A session id in the host's brand: `ses_` then 26 alphanumerics. The probe's
 * created sessions used 24 characters; the host accepts them, but the fixture's
 * shape is the documented one, so the probe matches it.
 * @param {string} seedText
 */
export function syntheticSessionId(seedText) {
  const suffix = sha256(seedText).replace(/[^A-Za-z0-9]/gu, '').slice(0, 26);
  return `ses_${suffix}`;
}

/**
 * Wait until the stub has seen no new request for `settleMs`. The synthetic
 * turn can be dispatched after the child's first response, so counting at
 * process exit alone would race it; this is the quiescence window the control
 * uses. Bounded by `maxMs` so a stuck host still produces a record.
 * @param {{count: () => number}} stub
 * @param {{settleMs?: number, maxMs?: number, pollMs?: number}} [options]
 */
export async function waitForQuiescence(stub, options = {}) {
  const settleMs = options.settleMs ?? 1_500;
  const maxMs = options.maxMs ?? 20_000;
  const pollMs = options.pollMs ?? 100;
  const started = Date.now();
  let last = stub.count();
  let lastChange = started;
  for (;;) {
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
    const now = stub.count();
    if (now !== last) {
      last = now;
      lastChange = Date.now();
    }
    const quietMs = Date.now() - lastChange;
    if (quietMs >= settleMs) return { requests: last, quietMs, waitedMs: Date.now() - started };
    if (Date.now() - started >= maxMs) {
      return { requests: last, quietMs, waitedMs: Date.now() - started, timedOut: true };
    }
  }
}

/* ------------------------------------------------------------------ control */

/**
 * The four single-prompt cost scenarios, each in its own world with its own
 * stub log. One user prompt per world; the only variable is the idle call.
 * @param {{opts: object, bin: string, evidence: string}} input
 */
async function runControl({ opts, bin, evidence }) {
  const root = join(evidence, 'control');
  rmSync(root, { recursive: true, force: true });
  const prompt = 'CONTROL-ONE: reply with exactly CONTROL-OK';
  const scenarios = [];
  for (const scenario of CONTROL_SCENARIOS) {
    const dir = join(root, `scenario-${scenario.id}`);
    const world = join(dir, 'world');
    const workDir = join(world, 'work');
    const pluginDir = join(world, 'probe-plugin');
    const configDir = join(world, '.config', 'opencode');
    const journalPath = join(dir, 'probe-journal.jsonl');
    const requestsPath = join(dir, 'stub-requests.jsonl');
    for (const path of [workDir, pluginDir, configDir, join(dir, 'logs')]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(join(workDir, 'README.txt'), 'offline single-prompt control world\n');
    const redirects = redirectEnv(world);
    for (const path of Object.values(redirects)) mkdirSync(path, { recursive: true });
    writeProbePlugin(pluginDir);
    const nonce = `RACOONS-SYNTHETIC-CONTROL-S${scenario.id}-${randomBytes(6).toString('hex').toUpperCase()}`;
    const sessionId = syntheticSessionId(`${nonce}:${scenario.id}:${Date.now()}`);
    const stub = await startStub({ logPath: requestsPath });
    try {
      writeProbeConfig(configDir, stub.url, pluginDir);
      const run = await launchRun({
        bin,
        task: prompt,
        sessionId,
        cwd: workDir,
        env: {
          ...childEnv(redirects, {}).env,
          CREMATOR_PROBE_JOURNAL: journalPath,
          CREMATOR_PROBE_NONCE: nonce,
          CREMATOR_PROBE_ARM: scenario.arm ? '1' : '0',
          CREMATOR_PROBE_SEAM: 'hook',
          CREMATOR_PROBE_RESUME: scenario.resume ? 'true' : 'false',
          CREMATOR_PROBE_DELIVERY: scenario.delivery,
        },
        timeoutMs: opts.timeoutMs,
        logLevel: opts.logLevel ?? null,
      });
      writeFileSync(join(dir, 'logs', 'stdout.log'), run.stdout);
      writeFileSync(join(dir, 'logs', 'stderr.log'), run.stderr);
      const quiescence = await waitForQuiescence(stub);
      const rows = stub.rows();
      const summary = summarizeRequests(rows, nonce);
      const details = mainRequestsDetail(rows, nonce, prompt);
      const journal = readJsonLines(journalPath);
      scenarios.push({
        id: scenario.id,
        label: scenario.label,
        arm: scenario.arm,
        resume: scenario.resume,
        delivery: scenario.delivery,
        nonce,
        sessionId,
        exitCode: run.code,
        signal: run.signal,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        stderrTail: run.stderr.slice(-1_500),
        requests: summary,
        mainRequests: summary.main,
        mainRequestsDetail: details,
        nonceRequestBodies: details.filter((row) => row.carriesNonce),
        syntheticTurnOrder: syntheticTurnOrder(details),
        quiescence,
        journal: {
          lines: journal.length,
          idle: journal.filter((row) => row.kind === 'idle').length,
          idleHookFired: journal.filter((row) => row.kind === 'idle-hook-fired').length,
          syntheticCalls: journal.filter((row) => row.kind === 'synthetic-call').map((row) => row.args),
          syntheticReturn: journal.filter((row) => row.kind === 'synthetic-return').map((row) => row.json),
          syntheticErrors: journal.filter((row) => row.kind === 'synthetic-error'),
          hookErrors: journal.filter((row) => row.kind === 'hook-error'),
          idleNoops: journal.filter((row) => row.kind === 'idle-noop'),
          idleSkips: journal.filter((row) => row.kind === 'idle-skip'),
          contextNonceIndexes: journal.filter((row) => row.kind === 'context')
            .map((row) => row.nonceIndex),
        },
        evidence: { journal: journalPath, requests: requestsPath },
      });
    } finally {
      await stub.close();
    }
  }
  const decision = decideControl(scenarios);
  const result = {
    schema: CONTROL_SCHEMA,
    prompt,
    decision,
    scenarios,
    evidence: { root },
  };
  const resultPath = join(evidence, 'control-result.json');
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return {
    compact: {
      schema: CONTROL_SCHEMA,
      counts: decision.counts,
      extraMainRequests: decision.extraMainRequests,
      appendCausesModelTurn: decision.appendCausesModelTurn,
      appendCostsExactlyOneMainRequest: decision.appendCostsExactlyOneMainRequest,
      queueDeliveryCausesModelTurn: decision.queueDeliveryCausesModelTurn,
      resumeTrueCausesModelTurn: decision.resumeTrueCausesModelTurn,
      syntheticTurnOrder: decision.syntheticTurnOrder,
      nonceRequestBodies: Object.fromEntries(scenarios.map((scenario) => [
        scenario.id,
        scenario.nonceRequestBodies.map((row) => ({
          seq: row.seq,
          nonceIndex: row.nonceIndex,
          nonceRole: row.nonceRole,
          messageCount: row.messageCount,
          roles: row.roles,
          bodyMessages: row.bodyMessages,
        })),
      ])),
      scenarios: scenarios.map((scenario) => ({
        id: scenario.id,
        label: scenario.label,
        mainRequests: scenario.mainRequests,
        mainSeqs: scenario.requests.mainSeqs,
        titleRequests: scenario.requests.title,
        exitCode: scenario.exitCode,
        syntheticTurnOrder: scenario.syntheticTurnOrder,
        syntheticReturn: scenario.journal.syntheticReturn,
        syntheticErrors: scenario.journal.syntheticErrors,
        hookErrors: scenario.journal.hookErrors,
      })),
      result: resultPath,
    },
    result,
    resultPath,
  };
}

/* ------------------------------------------------------------------ preflight */

/**
 * The fixture's own test: seed it, then let the host open and continue it. The
 * host's exit code and its first main request are the verdict; a refusal is
 * reported with the host's words, not a derived reason.
 * @param {{opts: object, bin: string, evidence: string, fixturePath: string}} input
 */
async function runPreflight({ opts, bin, evidence, fixturePath }) {
  const fixture = inspectFixture(fixturePath);
  const dir = join(evidence, 'preflight');
  rmSync(dir, { recursive: true, force: true });
  const world = join(dir, 'world');
  const workDir = join(world, 'work');
  const pluginDir = join(world, 'probe-plugin');
  const configDir = join(world, '.config', 'opencode');
  const journalPath = join(dir, 'probe-journal.jsonl');
  const requestsPath = join(dir, 'stub-requests.jsonl');
  for (const path of [workDir, pluginDir, configDir, join(dir, 'logs')]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(workDir, 'README.txt'), 'offline fixture preflight world\n');
  const redirects = redirectEnv(world);
  for (const path of Object.values(redirects)) mkdirSync(path, { recursive: true });
  writeProbePlugin(pluginDir);
  const refusePreflight = (reason, extra = {}) => ({
    schema: `${SCHEMA}/preflight`,
    fixture,
    refused: reason,
    ...extra,
  });
  if (!fixture.ok) {
    const result = refusePreflight('the fixture is not host-seedable', {
      refusals: fixture.refusals,
    });
    writeFileSync(join(evidence, 'preflight-result.json'), `${JSON.stringify(result, null, 2)}\n`);
    return { result, ok: false };
  }
  const databasePath = join(redirects.XDG_DATA_HOME, 'opencode', 'opencode.db');
  const seeded = seedSessionDb({
    sourceDbPath: fixturePath,
    sessionId: fixture.sessionId,
    targetDbPath: databasePath,
  });
  if (seeded.ok !== true) {
    const result = refusePreflight('the fixture seed failed', { seedRefusal: seeded.refused ?? null });
    writeFileSync(join(evidence, 'preflight-result.json'), `${JSON.stringify(result, null, 2)}\n`);
    return { result, ok: false };
  }
  // The fixture's directory is synthetic, so it does not exist here. The host
  // refuses a session whose location is missing; the world's copy is pointed
  // at the preflight's own work directory, and both ends are recorded.
  const relocation = relocateSeededSession(databasePath, fixture.sessionId, workDir);
  const nonce = `RACOONS-SYNTHETIC-PREFLIGHT-${randomBytes(6).toString('hex').toUpperCase()}`;
  const prompt = 'PREFLIGHT-ONE: reply with exactly PREFLIGHT-OK';
  const stub = await startStub({ logPath: requestsPath });
  let result;
  try {
    writeProbeConfig(configDir, stub.url, pluginDir);
    const run = await launchRun({
      bin,
      task: prompt,
      sessionId: fixture.sessionId,
      cwd: workDir,
      env: {
        ...childEnv(redirects, {}).env,
        CREMATOR_PROBE_JOURNAL: journalPath,
        CREMATOR_PROBE_NONCE: nonce,
        CREMATOR_PROBE_ARM: '0',
        CREMATOR_PROBE_SEAM: 'hook',
        CREMATOR_PROBE_RESUME: 'false',
        CREMATOR_PROBE_DELIVERY: 'none',
      },
      timeoutMs: opts.timeoutMs,
      logLevel: opts.logLevel ?? null,
    });
    writeFileSync(join(dir, 'logs', 'stdout.log'), run.stdout);
    writeFileSync(join(dir, 'logs', 'stderr.log'), run.stderr);
    const quiescence = await waitForQuiescence(stub);
    const rows = stub.rows();
    const summary = summarizeRequests(rows, nonce);
    const details = mainRequestsDetail(rows, nonce, prompt);
    const journal = readJsonLines(journalPath);
    const sessions = sessionIds(databasePath);
    const openedSeededSession = sessions.length === 1 && sessions[0] === fixture.sessionId;
    const contextCalls = journal.filter((row) => row.kind === 'context');
    result = {
      schema: `${SCHEMA}/preflight`,
      fixture,
      seed: {
        mode: 'fixture',
        ok: seeded.ok,
        counts: seeded.counts,
        copiedTables: seeded.copiedTables,
        notCopiedTables: seeded.notCopiedTables,
      },
      relocation,
      prompt,
      nonce,
      exitCode: run.code,
      signal: run.signal,
      durationMs: run.durationMs,
      stderrTail: run.stderr.slice(-2_000),
      stdoutTail: run.stdout.slice(-2_000),
      mainRequests: summary.main,
      mainRequestsDetail: details,
      titleRequests: summary.title,
      quiescence,
      sessionsInWorld: sessions,
      openedSeededSession,
      ranOneTurn: run.code === 0 && summary.main >= 1 && openedSeededSession,
      journal: {
        lines: journal.length,
        contextCalls: contextCalls.length,
        contextRoles: contextCalls.length > 0 ? contextCalls[0].roles : null,
        contextToolCount: contextCalls.length > 0 ? contextCalls[0].toolCount : null,
        hookErrors: journal.filter((row) => row.kind === 'hook-error'),
        syntheticErrors: journal.filter((row) => row.kind === 'synthetic-error'),
      },
      evidence: { root: dir, journal: journalPath, requests: requestsPath },
    };
  } finally {
    await stub.close();
  }
  const resultPath = join(evidence, 'preflight-result.json');
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return { result: { ...result, result: resultPath }, ok: result.ranOneTurn === true };
}

/* ------------------------------------------------------------------ main */

async function main() {
  let opts;
  try {
    opts = parseProbeArgs(process.argv.slice(2));
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const fixturePath = resolve(opts.fixture);
  const evidence = resolve(opts.evidence);
  mkdirSync(evidence, { recursive: true });
  const bin = resolveOpencodeBin(opts.opencodeBin);

  if (opts.control) {
    const control = await runControl({ opts, bin, evidence });
    process.stdout.write(`${JSON.stringify(opts.json ? control.result : control.compact)}\n`);
    return;
  }
  if (opts.preflight) {
    const preflight = await runPreflight({ opts, bin, evidence, fixturePath });
    process.stdout.write(`${JSON.stringify(opts.json ? preflight.result : {
      schema: preflight.result.schema,
      refused: preflight.result.refused ?? null,
      fixture: {
        ok: preflight.result.fixture.ok,
        sessionId: preflight.result.fixture.sessionId,
        model: preflight.result.fixture.model,
        workspaceColumns: preflight.result.fixture.workspaceColumns,
        messageIdsBranded: preflight.result.fixture.messageIdsBranded,
        messageIdsTotal: preflight.result.fixture.messageIdsTotal,
        refusals: preflight.result.fixture.refusals,
      },
      seed: preflight.result.seed?.counts ?? null,
      relocation: preflight.result.relocation ?? null,
      exitCode: preflight.result.exitCode ?? null,
      mainRequests: preflight.result.mainRequests ?? null,
      mainRequestsDetail: preflight.result.mainRequestsDetail ?? null,
      sessionsInWorld: preflight.result.sessionsInWorld ?? null,
      openedSeededSession: preflight.result.openedSeededSession ?? null,
      ranOneTurn: preflight.result.ranOneTurn ?? false,
      journal: preflight.result.journal ?? null,
      stderrTail: preflight.result.stderrTail ?? null,
      result: preflight.result.result ?? null,
    })}\n`);
    if (preflight.ok !== true) process.exitCode = 2;
    return;
  }

  const world = join(evidence, 'world');
  const workDir = join(world, 'work');
  const pluginDir = join(world, 'probe-plugin');
  const configDir = join(world, '.config', 'opencode');
  const journalPath = join(evidence, 'probe-journal.jsonl');
  const requestsPath = join(evidence, 'stub-requests.jsonl');
  const resultPath = join(evidence, 'result.json');

  rmSync(world, { recursive: true, force: true });
  rmSync(journalPath, { force: true });
  rmSync(requestsPath, { force: true });
  for (const dir of [workDir, pluginDir, configDir, join(evidence, 'logs')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(workDir, 'README.txt'), 'offline synthetic-message probe world\n');

  const nonce = `RACOONS-SYNTHETIC-PROBE-${randomBytes(6).toString('hex').toUpperCase()}`;
  const fixture = inspectFixture(fixturePath);

  // The world's host data locations all point inside the world; the child env
  // is deny-by-default, so no credential on this machine can reach it.
  const redirects = redirectEnv(world);
  for (const dir of Object.values(redirects)) mkdirSync(dir, { recursive: true });
  const baseEnv = childEnv(redirects, {}).env;
  const childEnvFor = (arm) => ({
    ...baseEnv,
    CREMATOR_PROBE_JOURNAL: journalPath,
    CREMATOR_PROBE_NONCE: nonce,
    CREMATOR_PROBE_ARM: arm ? '1' : '0',
    CREMATOR_PROBE_SEAM: opts.seam,
    CREMATOR_PROBE_RESUME: opts.resume ? 'true' : 'false',
    CREMATOR_PROBE_DELIVERY: opts.delivery,
  });

  // The plugin is a directory target; 2.4.0's loader warns and skips a file.
  writeProbePlugin(pluginDir);

  const stub = await startStub({ logPath: requestsPath });
  let result;
  try {
    writeProbeConfig(configDir, stub.url, pluginDir);

    // The session identity. A compatible fixture is seeded whole; the shipped
    // fixture is not, and the host creates the session on the first run.
    let sessionId;
    let seed;
    if (fixture.ok) {
      sessionId = fixture.sessionId;
      const seededDb = join(redirects.XDG_DATA_HOME, 'opencode', 'opencode.db');
      const seedResult = seedSessionDb({ sourceDbPath: fixturePath, sessionId, targetDbPath: seededDb });
      if (seedResult.ok !== true) refuse(seedResult.refused ?? 'the fixture seed failed without a reason');
      // The fixture's directory is synthetic and does not exist here; the host
      // refuses a session whose location is missing. Only the world's copy moves.
      const relocation = relocateSeededSession(seededDb, sessionId, workDir);
      if (relocation.ok !== true) refuse(relocation.refused ?? 'the seeded copy could not be relocated');
      seed = {
        mode: 'fixture',
        sessionId,
        rows: seedResult.counts,
        reasoning: seedResult.seededReasoning,
        relocation,
      };
    } else {
      sessionId = syntheticSessionId(`${nonce}:${Date.now()}`);
      seed = { mode: 'created', sessionId, refusals: fixture.refusals };
    }

    const tasks = [
      'PROBE-FIRST: reply with exactly PROBE-FIRST-OK',
      'PROBE-SECOND: reply with exactly PROBE-SECOND-OK',
      'PROBE-THIRD: reply with exactly PROBE-THIRD-OK',
      'PROBE-FOURTH: reply with exactly PROBE-FOURTH-OK',
      'PROBE-FIFTH: reply with exactly PROBE-FIFTH-OK',
    ];
    const runs = [];
    for (let index = 0; index < opts.runs; index += 1) {
      const mark = stub.count();
      const run = await launchRun({
        bin,
        task: tasks[index],
        sessionId,
        cwd: workDir,
        env: childEnvFor(index === 0),
        timeoutMs: opts.timeoutMs,
      });
      writeFileSync(join(evidence, 'logs', `run-${index + 1}.stdout.log`), run.stdout);
      writeFileSync(join(evidence, 'logs', `run-${index + 1}.stderr.log`), run.stderr);
      const rows = stub.rows().filter((row) => row.seq > mark);
      runs.push({
        index: index + 1,
        task: tasks[index],
        arm: index === 0 ? 1 : 0,
        exitCode: run.code,
        signal: run.signal,
        durationMs: run.durationMs,
        stdoutTail: run.stdout.slice(-2_000),
        stderrTail: run.stderr.slice(-2_000),
        requests: summarizeRequests(rows, nonce),
      });
      if (run.code !== 0) {
        // The host refused something. Its own words are the evidence; stop
        // rather than measuring a world the host did not run.
        const resultRefused = {
          schema: SCHEMA,
          nonce,
          refused: `run ${index + 1} exited ${String(run.code)}`,
          stdout: run.stdout,
          stderr: run.stderr,
          evidence: { journal: journalPath, requests: requestsPath },
        };
        writeFileSync(resultPath, `${JSON.stringify(resultRefused, null, 2)}\n`);
        process.stdout.write(`${JSON.stringify({
          schema: SCHEMA, refused: resultRefused.refused, nonce,
          stdout: run.stdout.slice(0, 2_000), stderr: run.stderr.slice(0, 2_000),
          result: resultPath,
        })}\n`);
        process.exitCode = 2;
        return;
      }
    }

    const journal = readJsonLines(journalPath);
    // A refused seam is not an answer. The host's own error text is the
    // evidence; stop instead of reporting a nonce that was never admitted.
    const seamErrors = opts.seam === 'hook'
      ? journal.filter((row) => row.kind === 'hook-error' && row.name === 'experimental.idle')
      : [];
    const syntheticErrors = journal.filter((row) => row.kind === 'synthetic-error');
    const syntheticReturns = journal.filter((row) => row.kind === 'synthetic-return');
    if (seamErrors.length > 0 || (opts.seam === 'hook' && syntheticErrors.length > 0 && syntheticReturns.length === 0)) {
      const refusal = {
        schema: SCHEMA,
        nonce,
        seam: opts.seam,
        refused: seamErrors.length > 0
          ? 'the host refused session.hook("experimental.idle")'
          : 'the host refused session.synthetic',
        seamErrors,
        syntheticErrors,
        evidence: { journal: journalPath, requests: requestsPath },
      };
      writeFileSync(resultPath, `${JSON.stringify(refusal, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify({
        schema: SCHEMA, refused: refusal.refused, nonce,
        errors: refusal.seamErrors.concat(refusal.syntheticErrors),
        result: resultPath,
      })}\n`);
      process.exitCode = 2;
      return;
    }
    const databasePath = join(redirects.XDG_DATA_HOME, 'opencode', 'opencode.db');
    const store = hostStoreRows(databasePath, sessionId);
    const analysis = analyzeProbe({
      journal,
      runs,
      nonce,
      resume: opts.resume,
      delivery: opts.delivery,
      seam: opts.seam,
      store,
    });
    const configOnDisk = readFileSync(join(configDir, 'opencode.json'), 'utf8');
    result = {
      schema: SCHEMA,
      nonce,
      fixture,
      seed,
      sessionId,
      sessionsInWorld: sessionIds(databasePath),
      config: {
        path: join(configDir, 'opencode.json'),
        sha256: sha256(configOnDisk),
        subagentTool: SUBAGENT_TOOL,
        pluginDir,
      },
      runs,
      analysis,
      hostStore: store,
      journalLines: journal,
      evidence: {
        root: evidence,
        world,
        journal: journalPath,
        requests: requestsPath,
        result: resultPath,
      },
    };
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    const compact = {
      schema: SCHEMA,
      nonce,
      seed: seed.mode,
      sessionId,
      seam: opts.seam,
      resume: opts.resume,
      delivery: opts.delivery,
      nonceInContextHook: analysis.nonceInContextHook,
      contextNonceRole: analysis.contextHook?.nonceRole ?? null,
      contextNonceIndex: analysis.contextHook?.nonceIndex ?? null,
      run1MainRequests: analysis.wire.run1MainRequests,
      run1MainSeqs: runs[0]?.requests?.mainSeqs ?? [],
      run1TitleRequests: analysis.wire.run1TitleRequests,
      run1NonceHits: analysis.wire.run1NonceHits,
      durableAcrossRestart: analysis.durability.run2CarriesNonce,
      syntheticReturn: analysis.syntheticReturn?.json ?? null,
      syntheticErrors: analysis.syntheticErrors,
      hookErrors: analysis.hookErrors,
      eventLines: analysis.eventLines,
      storeSyntheticRows: analysis.durability.syntheticStoreRows,
      result: resultPath,
    };
    process.stdout.write(`${JSON.stringify(opts.json ? result : compact)}\n`);
  } finally {
    await stub.close();
  }
}

// A direct run probes; an import (the pure helpers' test) does not.
if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`opencode-synthetic-probe.mjs: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(2);
  });
}
