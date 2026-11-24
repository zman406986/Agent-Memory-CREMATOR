#!/usr/bin/env node
/**
 * opencode 2.4.0 wire capture — the bench's observer for the real route.
 *
 * The host calls `context.session.hook("http.request", cb)` with the final
 * `Request` the provider driver is about to send
 * (`node_modules/@opencode/plugin/dist/promise/session.d.ts` `SessionHttpRequest`,
 * `request: Request`). This module turns that seam into one append-only JSONL
 * file of request bodies, so a real-route run can state what crossed the wire
 * instead of reconstructing it from receipts.
 *
 * Rules this module keeps:
 *   - the request is never mutated: only `clone()` is read, and every read is of
 *     the clone;
 *   - the hook never throws and never returns a promise, so the host's send path
 *     does not wait for the hash or the write;
 *   - the write is never awaited on the send path: records are queued, one
 *     timer flush and one process-exit flush drain them;
 *   - the file is opened once per process in append mode and `fsync`ed on every
 *     flush; nothing is ever truncated;
 *   - a body bigger than `maxBodyBytes` keeps its line, its full byte count and
 *     its full hash; only the recorded `body` is a prefix;
 *   - a request with no body (`clone.body === null`, e.g. the host's
 *     `GET /models`) is not an error: its line carries `bodyReadable: false`,
 *     `bodyBytes: 0` and `bodyless: true`, and no `bodyError`;
 *   - a body that cannot be read (`clone()` after the body was consumed) still
 *     produces its line, with `bodyReadable: false`;
 *   - `authorization` and `cookie` values are never written — only
 *     `{ present: true|false }`;
 *   - a caller-supplied redaction value (the route's provider key) is replaced
 *     by `<redacted>` in the body, the URL and the full-body hash, so a tool
 *     result that echoes the key out of the child environment cannot put it in
 *     `capture.jsonl`; `bodyBytes`/`bodySha256` describe the redacted body, and
 *     the line carries `rawBodyBytes` and `redactions` when any replacement
 *     happened;
 *   - a write failure is never silent: it is kept in memory and returned by
 *     `plugin.captureErrors()`, and the failed batch is dropped so a broken log
 *     path cannot grow the process's memory or duplicate lines on a later retry;
 *   - `<log>.summary.json` is rewritten on every flush (the timer's and the
 *     exit's) and once at setup, so a host that dies without running an exit
 *     handler still leaves a summary as new as its last line. The reader
 *     trusts a summary only when it is at least as new as the log.
 *
 * `seq` is assigned synchronously at hook entry. Lines are written in `seq`
 * order even when a later body finishes reading first, so the file is ordered
 * by arrival, not by hash completion.
 *
 * The plugin object the host mounts is `{ id, setup }` (2.4.0 `Plugin`), plus
 * three observation methods the bench reads: `captureErrors`,
 * `captureSummary`, `captureFlush`.
 */
import { createHash } from 'node:crypto';
import {
  closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const CAPTURE_PLUGIN_ID = 'racoons-capture';

const SENSITIVE_HEADERS = Object.freeze(['authorization', 'cookie']);
const ERROR_LIMIT = 100;
const activeFlushers = new Set();
let exitHookInstalled = false;

/** One process-exit flush path for every mounted capture, not one listener each. */
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const flush of activeFlushers) {
      try { flush(); } catch { /* process exit must not throw */ }
    }
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Decode a prefix as UTF-8. `{ stream: true }` holds back an incomplete trailing
 * sequence instead of replacing it, so a cut at `maxBodyBytes` never invents
 * U+FFFD. Bytes that are not UTF-8 at all are returned as base64.
 */
function decodePrefix(prefix) {
  if (prefix.length === 0) return { body: '', recorded: 0 };
  try {
    const body = new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: true });
    return { body, recorded: Buffer.byteLength(body, 'utf8') };
  } catch {
    return { body: null, bodyBase64: prefix.toString('base64'), recorded: prefix.length };
  }
}

/**
 * The byte sequences to replace, longest first so one value that contains
 * another is replaced whole. An empty or non-string value is ignored: a missing
 * key must not turn the capture into an error.
 */
function redactionNeedles(values) {
  const list = Array.isArray(values) ? values : [];
  return list
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => Buffer.from(value, 'utf8'))
    .sort((left, right) => right.length - left.length);
}

const REDACTION_MARKER = Buffer.from('<redacted>', 'utf8');

/**
 * A streaming byte redactor. It holds back the last `maxNeedle - 1` bytes so a
 * value split across two read chunks is still replaced; a value that starts
 * before the safe boundary and ends after it is replaced whole, so no prefix of
 * the value is emitted. The count is the number of replacements, not bytes.
 */
function createRedactor(needles) {
  const maxNeedle = needles.length === 0 ? 0 : needles[0].length;
  let carry = Buffer.alloc(0);
  let redactions = 0;

  /** The earliest needle in `buffer` at or after `from`, or null. */
  function firstMatch(buffer, from, limit) {
    let best = -1;
    let needle = null;
    for (const candidate of needles) {
      const at = buffer.indexOf(candidate, from);
      if (at !== -1 && (limit === null || at < limit) && (best === -1 || at < best)) {
        best = at;
        needle = candidate;
      }
    }
    return needle === null ? null : { at: best, needle };
  }

  function push(chunk) {
    if (needles.length === 0) return chunk;
    const buffer = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    if (buffer.length < maxNeedle) {
      carry = buffer;
      return Buffer.alloc(0);
    }
    const safeEnd = buffer.length - (maxNeedle - 1);
    const pieces = [];
    let position = 0;
    while (position < safeEnd) {
      const match = firstMatch(buffer, position, safeEnd);
      if (match === null) {
        pieces.push(buffer.subarray(position, safeEnd));
        position = safeEnd;
        break;
      }
      if (match.at > position) pieces.push(buffer.subarray(position, match.at));
      pieces.push(REDACTION_MARKER);
      redactions += 1;
      position = match.at + match.needle.length;
    }
    carry = position >= buffer.length ? Buffer.alloc(0) : buffer.subarray(position);
    return Buffer.concat(pieces);
  }

  function end() {
    if (needles.length === 0) return Buffer.alloc(0);
    const buffer = carry;
    carry = Buffer.alloc(0);
    const pieces = [];
    let position = 0;
    for (;;) {
      const match = firstMatch(buffer, position, null);
      if (match === null) {
        pieces.push(buffer.subarray(position));
        break;
      }
      if (match.at > position) pieces.push(buffer.subarray(position, match.at));
      pieces.push(REDACTION_MARKER);
      redactions += 1;
      position = match.at + match.needle.length;
    }
    return Buffer.concat(pieces);
  }

  return { push, end, count: () => redactions };
}

/**
 * Read the clone once: hash and count every byte, keep at most `maxBodyBytes` of
 * prefix. Never touches the original request. `redactValues` are replaced before
 * they reach the hash, the byte count or the kept prefix.
 */
async function readBody(request, maxBodyBytes, redactValues = []) {
  const clone = request.clone();
  if (clone.body === null) {
    // No body is not a read failure: `GET /models` and every other bodyless
    // request the host makes still gets its line, with nothing to hash.
    return { bodyless: true, total: 0, rawTotal: 0, prefix: Buffer.alloc(0),
      sha256: null, redactions: 0 };
  }
  const reader = clone.body.getReader();
  const hash = createHash('sha256');
  const redactor = createRedactor(redactionNeedles(redactValues));
  const kept = [];
  let keptBytes = 0;
  let total = 0;
  let rawTotal = 0;
  const keep = (chunk) => {
    if (keptBytes >= maxBodyBytes || chunk.length === 0) return;
    const take = Math.min(maxBodyBytes - keptBytes, chunk.length);
    if (take > 0) {
      kept.push(chunk.subarray(0, take));
      keptBytes += take;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      rawTotal += chunk.length;
      const redacted = redactor.push(chunk);
      total += redacted.length;
      hash.update(redacted);
      keep(redacted);
    }
  } finally {
    try { await reader.cancel(); } catch { /* the branch is already closed */ }
  }
  const tail = redactor.end();
  total += tail.length;
  hash.update(tail);
  keep(tail);
  return {
    total,
    rawTotal,
    prefix: Buffer.concat(kept, keptBytes),
    sha256: hash.digest('hex'),
    redactions: redactor.count(),
  };
}

/** Every header value except the two secrets, whose presence alone is recorded. */
function readHeaders(request) {
  const out = Object.create(null);
  const present = { authorization: false, cookie: false };
  const headers = request?.headers;
  try {
    if (headers && typeof headers.forEach === 'function') {
      headers.forEach((value, name) => {
        const key = String(name).toLowerCase();
        if (key === 'authorization' || key === 'cookie') {
          present[key] = true;
          return;
        }
        out[key] = String(value);
      });
    }
  } catch { /* an unreadable header bag is recorded as absence, not as a throw */ }
  for (const key of SENSITIVE_HEADERS) {
    try {
      if (typeof headers?.has === 'function' && headers.has(key)) present[key] = true;
    } catch { /* presence stays as the iteration saw it */ }
    out[key] = { present: present[key] };
  }
  return out;
}

/**
 * Replace every redaction value in one string. Used for the request URL, which
 * is not part of the body read but can carry the same value in a query.
 */
function redactText(value, redactValues) {
  if (typeof value !== 'string') return { value, redactions: 0 };
  const redactor = createRedactor(redactionNeedles(redactValues));
  const bytes = Buffer.concat([redactor.push(Buffer.from(value, 'utf8')), redactor.end()]);
  return { value: bytes.toString('utf8'), redactions: redactor.count() };
}

/**
 * `{ logPath, maxBodyBytes?, flushIntervalMs?, redactValues? }` -> the plugin
 * object the host mounts. `flushIntervalMs` defaults to 1000; tests raise it and
 * flush by hand. `redactValues` is the route's provider key (or any other value
 * that must never reach the log); it is not written anywhere itself.
 */
export function createCapturePlugin({
  logPath, maxBodyBytes = 8 * 1024 * 1024, flushIntervalMs = 1000, redactValues = [],
} = {}) {
  if (typeof logPath !== 'string' || logPath.length === 0) {
    throw new TypeError('createCapturePlugin: logPath must be a non-empty string');
  }
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new TypeError('createCapturePlugin: maxBodyBytes must be a positive integer');
  }
  if (!Number.isFinite(flushIntervalMs) || flushIntervalMs <= 0) {
    throw new TypeError('createCapturePlugin: flushIntervalMs must be a positive number');
  }

  const state = {
    nextSeq: 1,
    writeSeq: 1,
    pending: new Map(),
    ready: [],
    inFlight: 0,
    writtenLines: 0,
    writtenBytes: 0,
    truncatedLines: 0,
    droppedLines: 0,
    redactions: 0,
    errorCount: 0,
    errors: [],
    fd: null,
    timer: null,
  };

  /**
   * The sidecar's path. The loader and the reader both derive it from `logPath`
   * the same way, so one spelling exists.
   */
  const summaryPath = `${logPath}.summary.json`;

  function recordError(kind, error, lines = 0, bytes = 0) {
    state.errorCount += 1;
    if (state.errors.length >= ERROR_LIMIT) return;
    state.errors.push(Object.freeze({
      at: new Date().toISOString(),
      kind,
      message: errorMessage(error),
      lines,
      bytes,
    }));
  }

  function closeFd() {
    if (state.fd === null) return;
    try { closeSync(state.fd); } catch { /* already closed */ }
    state.fd = null;
  }

  function writeAll(fd, buffer) {
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error('capture: append wrote no bytes');
      offset += written;
    }
  }

  /**
   * Rewrite `<log>.summary.json` from the current counters. Called after every
   * flush and once at setup, so the sidecar is never older than the last line
   * the log holds — the property the reader checks before trusting it. A
   * failure here is swallowed: the sidecar is an observer's extra, and the log
   * itself is the capture.
   */
  function writeSummarySidecar() {
    try {
      mkdirSync(dirname(summaryPath), { recursive: true });
      const temporary = `${summaryPath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(captureSummary())}\n`, 'utf8');
      renameSync(temporary, summaryPath);
    } catch { /* the log itself is the capture; the summary is an extra */ }
  }

  function flushSync() {
    const batch = state.ready;
    state.ready = [];
    if (batch.length > 0) {
      const text = batch.map((entry) => entry.text).join('');
      const bytes = Buffer.byteLength(text, 'utf8');
      try {
        if (state.fd === null) {
          mkdirSync(dirname(logPath), { recursive: true });
          state.fd = openSync(logPath, 'a');
        }
        writeAll(state.fd, Buffer.from(text, 'utf8'));
        fsyncSync(state.fd);
        state.writtenLines += batch.length;
        state.writtenBytes += bytes;
        state.truncatedLines += batch.filter((entry) => entry.truncated).length;
      } catch (error) {
        state.droppedLines += batch.length;
        closeFd();
        recordError('flush', error, batch.length, bytes);
      }
    }
    // Written after the log batch and fsync, so its mtime is never older than
    // the last line's. An empty flush still rewrites it: the exit flush and the
    // timer's no-op ticks both leave a fresh sidecar behind.
    writeSummarySidecar();
  }

  /** Move every contiguous finished record, in `seq` order, onto the write queue. */
  function drain() {
    while (state.pending.has(state.writeSeq)) {
      const entry = state.pending.get(state.writeSeq);
      state.pending.delete(state.writeSeq);
      state.writeSeq += 1;
      if (entry !== null) state.ready.push(entry);
    }
  }

  async function captureRecord(input, seq) {
    const request = input?.request;
    let body = {
      bodyReadable: false,
      bodyBytes: 0,
      bodySha256: null,
      body: null,
      bodyRecordedBytes: 0,
      truncated: false,
    };
    let bodyRedactions = 0;
    if (request && typeof request.clone === 'function') {
      try {
        const read = await readBody(request, maxBodyBytes, redactValues);
        bodyRedactions = read.redactions;
        if (read.bodyless === true) {
          body = {
            bodyReadable: false,
            bodyBytes: 0,
            bodySha256: null,
            body: null,
            bodyRecordedBytes: 0,
            truncated: false,
            bodyless: true,
          };
        } else {
          const decoded = decodePrefix(read.prefix);
          body = {
            bodyReadable: true,
            bodyBytes: read.total,
            bodySha256: read.sha256,
            body: decoded.body,
            bodyRecordedBytes: decoded.recorded,
            truncated: read.total > maxBodyBytes,
            ...(decoded.bodyBase64 === undefined ? {} : { bodyBase64: decoded.bodyBase64 }),
            ...(read.redactions > 0
              ? { rawBodyBytes: read.rawTotal, redactions: read.redactions } : {}),
          };
        }
      } catch (error) {
        body.bodyError = errorMessage(error);
      }
    } else {
      body.bodyError = 'request has no clone()';
    }
    const url = redactText(
      typeof request?.url === 'string' ? request.url : null, redactValues);
    state.redactions += bodyRedactions + url.redactions;
    return {
      seq,
      at: new Date().toISOString(),
      sessionID: input?.sessionID ?? null,
      agent: input?.agent ?? null,
      model: input?.model ?? null,
      kind: input?.kind ?? null,
      method: typeof request?.method === 'string' ? request.method : null,
      url: url.value,
      ...(url.redactions > 0 ? { urlRedactions: url.redactions } : {}),
      headers: readHeaders(request),
      ...body,
    };
  }

  /** The host hook. Synchronous by design: it clones, starts the read, returns. */
  function onHttpRequest(input) {
    let seq;
    try { seq = state.nextSeq++; } catch { return; }
    state.inFlight += 1;
    let done = false;
    const finish = (record, error) => {
      if (done) return;
      done = true;
      try {
        if (error) recordError('capture', error, 0, 0);
        if (record === null) {
          state.pending.set(seq, null);
        } else {
          try {
            state.pending.set(seq, {
              text: `${JSON.stringify(record)}\n`,
              truncated: record.truncated === true,
            });
          } catch (encodeError) {
            recordError('encode', encodeError, 1, 0);
            state.pending.set(seq, null);
          }
        }
        drain();
      } catch { /* the hook must never throw into the host */ } finally {
        state.inFlight -= 1;
      }
    };
    let capture;
    try {
      capture = captureRecord(input, seq);
    } catch (error) {
      finish(null, error);
      return;
    }
    capture.then((record) => finish(record, null), (error) => finish(null, error));
  }

  async function setup(context) {
    const hook = context?.session?.hook;
    installExitHook();
    activeFlushers.add(flushSync);
    // A summary before the first hook event: a host that dies before any line
    // is written still leaves a sidecar, and the reader can tell "zero lines
    // seen" from "the summary was lost".
    writeSummarySidecar();
    if (state.timer === null) {
      state.timer = setInterval(flushSync, flushIntervalMs);
      state.timer.unref?.();
    }
    if (typeof hook !== 'function') {
      recordError('setup', new Error('host context has no session.hook'), 0, 0);
      return () => close();
    }
    try {
      await hook('http.request', onHttpRequest);
    } catch (error) {
      recordError('register', error, 0, 0);
    }
    return () => close();
  }

  function close() {
    flushSync();
    if (state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
    }
    activeFlushers.delete(flushSync);
    closeFd();
  }

  function captureSummary() {
    return Object.freeze({
      lines: state.writtenLines,
      bytes: state.writtenBytes,
      errors: state.errorCount,
      truncatedLines: state.truncatedLines,
      redactions: state.redactions,
      pending: state.ready.length + state.pending.size + state.inFlight,
      dropped: state.droppedLines,
    });
  }

  return Object.freeze({
    id: CAPTURE_PLUGIN_ID,
    setup,
    captureErrors: () => Object.freeze(state.errors.slice()),
    captureSummary,
    captureFlush: () => { flushSync(); return captureSummary(); },
  });
}
