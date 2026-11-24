#!/usr/bin/env node
// ISSUE-019 Gate 0 — cache calibration probe on the live route. Call A = fixed deterministic ~2k-token prefix;
// call B = A's exact bytes + a tiny suffix. Raw `usage` is stored verbatim per call. This script
// only lists observed fields; the GO/NO-GO is recorded by the runner, never computed here.
// Replay mode (--sends/--gaps/--prefix-file) sends one exact prompt N times instead, so a hit can be
// attributed to repeat count or elapsed time without the bytes changing.
//   node dev/bench/cache-probe.mjs --dry   # offline: key check + payload build, no HTTP
//   node dev/bench/cache-probe.mjs         # LIVE: exactly two calls, kill timer 120 s
// Flags: --dry --kill-ms 120000 --settle-ms 7000 --base <url> --model <id>
//        --prefix-tokens <n>  target prefix size; omitted = the original 100-record (~2343-token) prefix
//        --tag <s>            label folded into the evidence filename, so pairs stay distinguishable
//        --nonce <s>          constant line at byte 0, so separate pairs never share prefix bytes
//                             (filler(n) is a prefix of filler(m) for n<m; without a nonce a shorter
//                             pair would inherit a longer pair's warmth and measure nothing)
//        --prefix-file <p>    pin the prompt bytes in a JSON file: written once from the sizing flags,
//                             then replayed verbatim, so separate processes send identical bytes
//        --sends <n>          replay mode: send that one prompt n times instead of an A/B pair
//        --gaps <ms,ms,...>   waits between replay sends (last value repeats); default --settle-ms
// Key: refs: DEEPSEEK_API_KEY in ~/.dsh/.credentials.yaml, read in-process, never printed or exported.
import fs from 'node:fs';
import path from 'node:path';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';
import { timerDelayRefusal } from '../shared/timer-ms.mjs';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CRED = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', '.credentials.yaml');
// The probe's flags, parsed once at module load (it is a single-use script, not a
// module anything imports). A flag given with no value is refused by name: the
// old `arg()` returned `true`, which `Number()` silently turned into 1.
const PROBE_OPTIONS = optionsOf([
  ['--dry', 'boolean'],
  ['--kill-ms', 'string', 'killMs'],
  ['--settle-ms', 'string', 'settleMs'],
  ['--base', 'string'],
  ['--model', 'string'],
  ['--prefix-tokens', 'string', 'prefixTokens'],
  ['--tag', 'string'],
  ['--nonce', 'string'],
  ['--prefix-file', 'string', 'prefixFile'],
  ['--sends', 'string'],
  ['--gaps', 'string'],
]);
const { values: FLAGS } = parseDevArgs(process.argv.slice(2), {
  options: PROBE_OPTIONS,
  refuse: (message) => {
    process.stderr.write(`cache-probe.mjs: ${message}\n`);
    process.exit(2);
  },
});
const DRY = FLAGS.dry ?? false;
const KILL_MS = Number(FLAGS.killMs ?? '120000');
// A kill delay above the platform maximum would fire at 1 ms (ISSUE-580).
const tooLongKill = timerDelayRefusal(KILL_MS, '--kill-ms');
if (tooLongKill !== null) {
  process.stderr.write(`cache-probe.mjs: ${tooLongKill}\n`);
  process.exit(2);
}
const SETTLE_MS = Number(FLAGS.settleMs ?? '7000');
// A --settle-ms that is fractional, negative, or not a number would reach a
// `setTimeout`/wait as a silent 0 ms. It is refused by name, as --kill-ms is
// (ISSUE-597); only an absent flag takes the default.
const badSettle = FLAGS.settleMs === undefined
  ? null
  : (!Number.isSafeInteger(SETTLE_MS) || SETTLE_MS < 0
    ? `--settle-ms needs a non-negative integer, got ${FLAGS.settleMs}`
    : timerDelayRefusal(SETTLE_MS, '--settle-ms'));
if (badSettle !== null) {
  process.stderr.write(`cache-probe.mjs: ${badSettle}\n`);
  process.exit(2);
}
const BASE = String(FLAGS.base ?? 'https://api.deepseek.com/v1');
const MODEL = String(FLAGS.model ?? 'deepseek-flash');
const DEADLINE = Date.now() + KILL_MS;
// Prefix sizing. The original 100-record prefix measured 9072 bytes -> 2343 prompt tokens on the live route,
// so one record ~= 23.43 tokens. --prefix-tokens converts a token target into a record count; the
// byte count and the provider's own prompt_tokens stay the authority, this is only a sizing knob.
const PREFIX_TOKENS = FLAGS.prefixTokens === undefined ? null : Number(FLAGS.prefixTokens);
const TOKENS_PER_RECORD = 23.43;
const RECORDS = PREFIX_TOKENS === null ? 100 : Math.max(1, Math.round(PREFIX_TOKENS / TOKENS_PER_RECORD));
const TAG = FLAGS.tag === undefined ? '' : '-' + String(FLAGS.tag).replace(/[^A-Za-z0-9_-]/g, '');
const NONCE = FLAGS.nonce === undefined ? '' : String(FLAGS.nonce).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
// Replay mode: send ONE exact prompt text N times instead of an A/B pair, so a hit can be
// attributed to repeat count or to elapsed time without changing the bytes. --prefix-file pins
// the text in a JSON file: created from the sizing flags on first use, replayed verbatim after,
// so separate processes send byte-identical prompts. --gaps is a comma list of ms waits between
// sends (a single value repeats); the last value repeats if fewer gaps than sends are given.
const PREFIX_FILE = FLAGS.prefixFile === undefined ? null : path.resolve(ROOT, String(FLAGS.prefixFile));
// `--sends 2abc` used to parse to NaN and fold to 0, which silently ran the
// paid A/B pair instead of the replay. A given value must be a non-negative
// integer; the old `|| 0` also hid a negative one (ISSUE-597).
const SENDS = FLAGS.sends === undefined ? 0 : Number(FLAGS.sends);
if (FLAGS.sends !== undefined && (!Number.isSafeInteger(SENDS) || SENDS < 0)) {
  process.stderr.write(`cache-probe.mjs: --sends needs a non-negative integer, got ${FLAGS.sends}\n`);
  process.exit(2);
}
const GAPS = String(FLAGS.gaps ?? String(FLAGS.settleMs ?? '7000')).split(',').map((v) => Number(v)).filter((n) => Number.isFinite(n) && n >= 0);
if (!GAPS.length) throw new Error('--gaps needs at least one non-negative number');
const REPLAY = PREFIX_FILE !== null || SENDS > 0;
if (REPLAY && SENDS < 1) throw new Error('replay mode needs --sends <n>, n >= 1');
const killTimer = setTimeout(() => { console.error(`FATAL kill timer fired (${KILL_MS} ms); exiting 124`); process.exit(124); }, KILL_MS);
killTimer.unref?.(); // must not hold the loop open on clean exit
console.log(`[kill-timer] armed ${KILL_MS} ms; fires ${new Date(DEADLINE).toISOString()}`);
function loadKey() {
  if (!fs.existsSync(CRED)) return { key: null, source: 'missing-file' };
  const m = fs.readFileSync(CRED, 'utf8').match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
  return m ? { key: m[1], source: CRED } : { key: null, source: 'missing-in-file' };
}
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Buffer.from(d).toString('hex');
}
// Deterministic filler: no RNG, no clock, no locale.
const WORDS = ['harbor', 'lattice', 'copper', 'meadow', 'signal', 'canyon', 'fabric', 'orchard', 'lantern', 'glacier', 'cobalt', 'tally', 'marrow', 'abacus', 'kettle', 'quartz'];
function filler(n = 100) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const w = [];
    for (let j = 0; j < 8; j++) w.push(WORDS[(i * 7 + j * 3) % WORDS.length]);
    s += `record ${String(i).padStart(4, '0')}: ${w.join(' ')}; checksum ${((i * 2654435761) >>> 0).toString(16)};\n`;
  }
  return s;
}
const BUILT_PREFIX = (NONCE ? `nonce ${NONCE}\n` : '') + filler(RECORDS);
// In replay mode --prefix-file wins: the exact bytes are read back (or written once on first use)
// and the sizing flags are irrelevant after that, so every send in every process is byte-identical.
let PREFIX = BUILT_PREFIX;
let PREFIX_FROM_FILE = false;
let FILE_NONCE = null; // provenance: a pinned file carries its nonce inside the bytes
if (REPLAY && PREFIX_FILE && fs.existsSync(PREFIX_FILE)) {
  const saved = JSON.parse(fs.readFileSync(PREFIX_FILE, 'utf8'));
  if (typeof saved.text !== 'string' || saved.text.length === 0) throw new Error(`--prefix-file ${PREFIX_FILE} has no text`);
  PREFIX = saved.text;
  PREFIX_FROM_FILE = true;
  FILE_NONCE = typeof saved.nonce === 'string' ? saved.nonce : null;
}
const PROMPT = PREFIX + '\nReply with the single word: ALPHA';
// The nonce that governs isolation is the one inside the bytes actually sent: --nonce when the
// prompt was built here, otherwise the nonce recorded in the pinned prefix file. Writing null for
// a file-built prompt loses the only provenance that makes two pairs provably distinct.
const EFFECTIVE_NONCE = NONCE || FILE_NONCE;
const A_TEXT = PROMPT;
const B_TEXT = A_TEXT + '\nIgnore that; reply with the single word: BETA.';
const body = (text) => ({ model: MODEL, temperature: 0, max_tokens: 32, stream: false, messages: [{ role: 'user', content: text }] });
const A_BODY = body(A_TEXT), B_BODY = body(B_TEXT), aB = Buffer.from(A_TEXT), bB = Buffer.from(B_TEXT);
const prefixOk = bB.length > aB.length && bB.subarray(0, aB.length).equals(aB);
const suffixBytes = bB.length - aB.length;
const now = new Date();
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const OUT_DIR = path.join(ROOT, 'scratchpad', 'spike-008', 'v4', 'probe', stamp);
const OUT_FILE = path.join(OUT_DIR, `probe${TAG}-${now.toISOString().replace(/[:.]/g, '-')}.json`);
async function call(key, label, payload, text) {
  const remain = DEADLINE - Date.now();
  if (remain < 5000) throw new Error(`kill-timer budget too low before ${label} (${remain} ms)`);
  const t = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(remain),
  });
  const rawBody = await res.text();
  const latencyMs = Date.now() - t;
  let json = null;
  try { json = JSON.parse(rawBody); } catch { /* non-JSON body kept verbatim */ }
  const usagePresent = !!json && Object.hasOwn(json, 'usage');
  return {
    label, httpStatus: res.status, ok: res.ok, latencyMs,
    sentAt: new Date(t).toISOString(), receivedAt: new Date(t + latencyMs).toISOString(),
    promptBytes: Buffer.byteLength(text),
    promptSha256: await sha256(text),
    usagePresent, usage: usagePresent ? json.usage : null, // verbatim object, unedited, unmapped
    content: json?.choices?.[0]?.message?.content ?? null, rawBody,
  };
}

const CANDIDATES = ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'cached_tokens', 'prompt_tokens_details.cached_tokens', 'cache_read_input_tokens'];
function writeEvidence(meta, calls) {
  const evidence = {
    probe: REPLAY ? 'ISSUE-019 discriminator: repeat one exact prompt N times' : 'ISSUE-019 gate 0 cache calibration',
    protocol: REPLAY ? `one prompt, ${SENDS} sends, gaps ${GAPS.join(',')} ms` : 'A=fixed prefix, B=A bytes + suffix, settle before B',
    startedAt: now.toISOString(), finishedAt: new Date().toISOString(), dry: DRY, base: BASE, model: MODEL,
    killTimer: { armedMs: KILL_MS, firesAt: new Date(DEADLINE).toISOString() }, settleMs: SETTLE_MS,
    nonce: EFFECTIVE_NONCE, prefixFile: PREFIX_FILE, prefixFromFile: PREFIX_FROM_FILE,
    sends: REPLAY ? SENDS : null, gaps: REPLAY ? GAPS : null,
    key: { found: !!meta.key, source: meta.source }, prompt: meta.prompt,
    calls: calls.map((c) => ({ ...c, usageRaw: c.usage == null ? null : JSON.stringify(c.usage) })),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2));
  console.log(`[evidence] ${OUT_FILE}`);
}

function flat(o, pre = '', out = []) {
  for (const [k, v] of Object.entries(o)) {
    const q = pre ? `${pre}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, q, out); else out.push([q, v]);
  }
  return out;
}
function printUsage(calls) {
  const rows = [];
  for (const c of calls) {
    if (c.usage == null) { rows.push([c.label, '(usage ABSENT)', '']); continue; }
    for (const [key, v] of flat(c.usage)) rows.push([c.label, key, JSON.stringify(v)]);
  }
  const all = [['call', 'usage field', 'value'], ...rows];
  const w = [0, 1, 2].map((i) => Math.max(...all.map((r) => r[i].length)));
  for (const r of all) console.log(`  ${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2]}`);
  const seen = [...new Set(rows.map((r) => r[1]))].filter((n) => CANDIDATES.includes(n));
  console.log(`[cache-fields] observed known cache field names: ${seen.length ? seen.join(', ') : 'none'}`);
  console.log('[done] evidence written; GO/NO-GO is recorded by the runner, not by this script');
}
async function main() {
  const k = loadKey();
  console.log(`[key] DEEPSEEK_API_KEY: ${k.key ? 'found' : 'not found'} in ${k.source}`);
  if (!k.key && !DRY) { console.error('FATAL live run needs DEEPSEEK_API_KEY; no call made'); process.exit(2); }
  const meta = { key: !!k.key, source: k.source, tag: TAG || null, nonce: EFFECTIVE_NONCE, prompt: {
    prefixTokensTarget: PREFIX_TOKENS, prefixRecords: RECORDS,
    prefixBytes: Buffer.byteLength(PREFIX), prefixSha256: await sha256(PREFIX),
    aBytes: aB.length, aSha256: await sha256(A_TEXT), bBytes: bB.length, bSha256: await sha256(B_TEXT),
    suffixBytes, prefixAssertion: prefixOk ? 'PASS' : 'FAIL', messagesPerCall: 1, role: 'user',
  } };
  const p = meta.prompt;
  console.log(`[prompt] ${RECORDS} records, target ${PREFIX_TOKENS ?? 2343} tokens; prefix ${p.prefixBytes} bytes sha256=${p.prefixSha256} est_tokens≈${Math.round(p.prefixBytes / 4)}`);
  console.log(`[prompt] A ${p.aBytes} bytes sha256=${p.aSha256}`);
  console.log(`[prompt] B ${p.bBytes} bytes sha256=${p.bSha256} suffix=+${suffixBytes} bytes`);
  console.log(`[body] A ${Buffer.byteLength(JSON.stringify(A_BODY))} bytes; B ${Buffer.byteLength(JSON.stringify(B_BODY))} bytes; model=${MODEL}; base=${BASE}`);
  console.log(`[nonce] ${EFFECTIVE_NONCE ?? '(none)'}${PREFIX_FROM_FILE ? ' (from prefix file)' : ''}`);
  if (!prefixOk) { console.error('FATAL B does not byte-extend A; refusing to send'); process.exit(2); }
  console.log('[assert] B starts with A byte-for-byte: PASS');
  if (!PREFIX_FROM_FILE && PREFIX_FILE) {
    fs.mkdirSync(path.dirname(PREFIX_FILE), { recursive: true });
    fs.writeFileSync(PREFIX_FILE, JSON.stringify({ text: PREFIX, createdAt: now.toISOString(), nonce: NONCE || null }, null, 2));
    console.log(`[prefix-file] written ${PREFIX_FILE} (${Buffer.byteLength(PREFIX)} bytes)`);
  } else if (PREFIX_FROM_FILE) {
    console.log(`[prefix-file] loaded ${PREFIX_FILE}; sizing flags ignored, bytes come from the file`);
  }
  if (DRY) {
    console.log(`[dry] no HTTP calls made; live evidence would go to ${OUT_FILE}`);
    console.log('[dry] PASS: key file checked, payloads built, prefix assertion passed');
    process.exit(0);
  }
  if (REPLAY) {
    console.log(`[replay] one prompt sha256=${p.aSha256}, ${SENDS} sends, gaps ${GAPS.join(',')} ms`);
    const calls = [];
    for (let i = 0; i < SENDS; i++) {
      if (i > 0) {
        const gap = GAPS[Math.min(i - 1, GAPS.length - 1)];
        const waitMs = Math.max(0, Math.min(gap, DEADLINE - Date.now() - 15000));
        console.log(`[gap] send ${i + 1}: sleeping ${waitMs} ms (requested ${gap} ms)`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      const c = await call(k.key, `S${i + 1}`, A_BODY, A_TEXT);
      calls.push(c);
      const u = c.usage || {};
      console.log(`[send ${i + 1}] http=${c.httpStatus} ${c.latencyMs} ms prompt=${u.prompt_tokens} hit=${u.prompt_cache_hit_tokens} miss=${u.prompt_cache_miss_tokens} write=${u.prompt_cache_write_tokens} cached=${u.prompt_tokens_details?.cached_tokens}`);
      if (!c.ok) { writeEvidence(meta, calls); console.error(`FATAL send ${i + 1} failed (http ${c.httpStatus}); stopping`); process.exit(1); }
    }
    writeEvidence(meta, calls);
    printUsage(calls);
    return;
  }
  const calls = [await call(k.key, 'A', A_BODY, A_TEXT)];
  console.log(`[call A] http=${calls[0].httpStatus} ${calls[0].latencyMs} ms usage=${calls[0].usagePresent ? 'present' : 'ABSENT'}`);
  if (!calls[0].ok) {
    writeEvidence(meta, calls);
    console.error(`FATAL call A failed (http ${calls[0].httpStatus}); B not sent`);
    process.exit(1);
  }
  const waitMs = Math.max(0, Math.min(SETTLE_MS, DEADLINE - Date.now() - 15000));
  console.log(`[settle] sleeping ${waitMs} ms before B`);
  await new Promise((r) => setTimeout(r, waitMs));
  calls.push(await call(k.key, 'B', B_BODY, B_TEXT));
  console.log(`[call B] http=${calls[1].httpStatus} ${calls[1].latencyMs} ms usage=${calls[1].usagePresent ? 'present' : 'ABSENT'}`);
  writeEvidence(meta, calls);
  printUsage(calls);
}

main().catch((e) => { console.error(`FATAL ${e && e.stack ? e.stack : e}`); process.exit(1); });
