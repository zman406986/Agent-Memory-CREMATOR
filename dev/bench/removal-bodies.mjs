/**
 * The removal rule: the request body proves both halves — the removed unit is
 * gone and the surviving twin is still there.
 *
 * What proves a removal is the request body the host would send. A request's
 * receipt is reported beside the body and never trusted: a receipt can sit in a
 * request that still carries the removed bytes, and a correct per-request
 * re-application leaves a receipt on the request it rewrote. Counting receipts
 * proves neither half.
 *
 * **Both halves are required, per request.** An absent marker alone is also what
 * a host that dropped the tail looks like, and what a plan that removed both
 * copies looks like. So each request must also carry every surviving-twin marker
 * it was asked to require: the twin's call id, and, for a file read, the file
 * sentinel **inside the twin's own tool-result message**. The sentinel is not
 * required anywhere in the body: a stale-read lane's write call carries the same
 * bytes it wrote, so a body-wide scan would let a request that lost the twin
 * read's result but kept the write call pass. The message-scoped check is what
 * makes the twin half name the twin. The twin check is per request, not a
 * control taken before the removal.
 *
 * The rule is pure: it takes captured requests, the exact removed markers, the
 * exact surviving markers and the twin-result requirements, and returns a
 * verdict plus the per-request rows. It imports one bench module
 * (`receipt-line.mjs`, the single receipt definition) and no product code, so
 * the benchmark runner can adopt it as-is.
 *
 * Inputs:
 *   - `requests`: the runner's main-request rows, in order. A row is either a
 *     message array or an object carrying `messages` / `body.messages`; `seq`
 *     and `receipt_messages` are read when present. A row with no body fails:
 *     the rule cannot prove anything about a request it cannot read.
 *   - `removed`: one or more markers of the removed unit, as they appear on the
 *     wire — text unique to its bytes, or its call id. An empty list is not a
 *     vacuous pass: a check that names nothing proves nothing. A marker that a
 *     surviving duplicate legitimately still carries (the same file read twice)
 *     names bytes, not the unit; name the call id or a sentinel that only the
 *     removed unit held.
 *   - `options.survives`: markers of the surviving twin that every request must
 *     still carry, anywhere in the body. The twin's call id names the call part;
 *     an empty list means the caller has no twin call to require.
 *   - `options.twinResults`: `{callId, markers}` rows. Each call id must have a
 *     tool-result message addressed to it, and every marker must appear inside
 *     that message (not anywhere else in the body). This is the file sentinel's
 *     only valid home: the bytes a read returned.
 *   - `options.receiptMarkers`: the markers that must not appear outside a
 *     receipt line's target slot. The product's receipt line legitimately names
 *     the node id (which contains a tool unit's call id) in its target, so a
 *     generic rule cannot reject a marker there. The caller that knows the
 *     unit's identity — the lane's call id and marker sentinels, a recall's call
 *     ids — names them here; a receipt line carrying one in its label, after its
 *     recall marker, or twice in its target is scanned and fails instead of
 *     being allowed through.
 *   - `options.receiptContentMarkers`: markers that must not appear anywhere in
 *     a receipt line, including its target. A content marker is bytes from the
 *     removed body, never a path or a node id. A receipt message that carries
 *     one counts as the removed bytes still being in the body, even when the
 *     marker is not also a removed marker (a superseded lane's unit file
 *     sentinel cannot be a body-wide marker, because the surviving twin
 *     legitimately carries the same file bytes).
 *
 * The receipt **count** recorded beside a body verdict comes from the captured
 * row's own `receipt_messages` field, not from counting receipt messages here;
 * the message scan is for content and for leaks. Adapter receipts are excluded
 * from the surviving-twin scans — a receipt that names the twin must not satisfy
 * either half — and their own record line is allowed in the removed-byte scan:
 * the product's line names the unit it replaced, and that pointer must not read
 * as the removed unit still being there. **The allowance is the adapter's
 * record**: a `racoonsRecordId` field or a `racoons-record:` message id, or the
 * exact wire shape a user receipt serializes to (`isWireReceiptMessage`: user
 * role, one or more receipt lines and nothing else, no tool call or result id).
 * The wire shape is what survives opencode's serialization, which keeps only
 * `role` and `content`. A tool result that quotes a receipt line, a user message
 * carrying receipt text plus anything else, and a restored archive do not meet
 * that shape, so they are scanned like any other message and a removed marker
 * inside them fails the request (audit finding 9). The allowance is not
 * blind even for a real receipt: before a receipt line is skipped, it is checked
 * for the markers the caller names in `options.receiptMarkers` — a lane's call
 * id and sentinels, a recall's call ids. A marker outside the line's target slot
 * (in the ranges, the label, or after the recall id) is a leak; a content marker
 * named in `options.receiptContentMarkers` is a leak anywhere, and a receipt
 * carrying one makes the request's `carriesRemoved` true. A file path or recall
 * id passed only as a removed marker is not automatically a receipt marker.
 * **Everything else a receipt carries is scanned.** A receipt-shaped
 * message (the marker field, the record id, the receipt line) is not a hiding
 * place: its other strings are read for the removed markers like any other
 * message's, and an adapter receipt line longer than the product can render is a
 * named failure (`receiptShapeProblem`). The earlier rule excluded the whole
 * message, so a receipt that carried the removed bytes was invisible to the scan.
 *
 * **The absence proof is decoded-string level, and the verdict says so.** The
 * scan reads every JSON-decoded string; a request body that re-encodes the
 * removed fragment (base64, percent, another charset) is outside it. Where a
 * captured row carries the raw body text (`raw_body_text`, attached by
 * `readCaptureLog` and never serialized; a caller may pass `raw_body`), the
 * fragment's UTF-8 bytes and sha256 are searched there too, and an occurrence
 * the decoded strings do not account for fails the request — a fragment hidden in
 * a JSON property key is caught that way. A capture with no raw body text
 * records the limit instead of implying a byte-level proof: its verdict is
 * `measured: false` with `status: 'not-applicable'`, never a vacuous pass. Every
 * verdict carries `scope` (`removalAbsenceScopeLabel` renders it for a claim
 * line).
 *
 * **The scan cannot be silently shallow.** `stringsOf` walks every string at any
 * depth; `countStrings` is an independent iterative walk over the same value.
 * The verdict fails when the two counts differ, so a future depth cap in the
 * recursive walk is a named failure, never a false pass.
 */

import { createHash } from 'node:crypto';
import {
  allowedReceiptString, isAdapterReceiptMessage, isReceiptMessage, receiptShapeProblem,
} from './receipt-line.mjs';

export { isReceiptMessage, isAdapterReceiptMessage };

/** Every string a message or message array carries, at any depth. */
export function stringsOf(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringsOf(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) stringsOf(item, out);
  }
  return out;
}

/**
 * The same walk, iterative and independent of `stringsOf`, so a cap or a missed
 * branch in the recursive scan shows up as a count mismatch. `keep` applies to
 * each string, so the count covers exactly the strings the removed-byte scan
 * reads (a receipt message's own record line is not one of them).
 */
export function countStrings(value, keep = () => true) {
  let count = 0;
  const stack = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'string') {
      if (keep(item) === true) count += 1;
      continue;
    }
    if (Array.isArray(item)) {
      for (const child of item) stack.push(child);
      continue;
    }
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) stack.push(child);
    }
  }
  return count;
}

/**
 * The strings of one message the removed-byte scan must read. An adapter
 * receipt message (marker field, record id, or exact user wire shape)
 * contributes everything except its own record line and record id; an ordinary
 * message — including a tool result that quotes a receipt line — contributes
 * every string. The receipt line is checked for the removed markers first: a
 * line carrying one is not allowed through, so a call id or content marker
 * placed inside the product's own line is scanned.
 * @param {unknown} message
 * @param {{markers: string[], contentMarkers: string[]}} receiptPolicy the
 *   receipt allowance: which markers may sit in a receipt line's target slot,
 *   and which must never appear in a receipt line at all
 * @returns {string[]}
 */
function removedScanStringsOf(message, receiptPolicy) {
  const strings = stringsOf(message);
  if (!isAdapterReceiptMessage(message)) return strings;
  return strings.filter((text) => !allowedReceiptString(message, text, receiptPolicy));
}

/**
 * The strings one message contributes to the removed-byte scan, independently
 * counted. The same marker-aware allowance as `removedScanStringsOf`.
 * @param {unknown} message
 * @param {{markers: string[], contentMarkers: string[]}} receiptPolicy
 */
function independentScanCount(message, receiptPolicy) {
  const receipt = isAdapterReceiptMessage(message);
  return countStrings(message,
    (text) => !receipt || !allowedReceiptString(message, text, receiptPolicy));
}

/** The messages a captured request row carries, or `null` when it carries none. */
function messagesOf(row) {
  if (Array.isArray(row)) return row;
  if (row !== null && typeof row === 'object') {
    if (Array.isArray(row.messages)) return row.messages;
    if (row.body !== null && typeof row.body === 'object' && Array.isArray(row.body.messages)) {
      return row.body.messages;
    }
  }
  return null;
}

/** The non-empty strings in a marker list, or an empty list. */
function markersOf(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item) => typeof item === 'string' && item.length > 0);
}

/**
 * How many times `marker` occurs in `text`, without overlapping matches.
 * @param {string} text
 * @param {string} marker
 * @returns {number}
 */
export function occurrencesOf(text, marker) {
  if (typeof text !== 'string' || typeof marker !== 'string' || marker.length === 0) return 0;
  let count = 0;
  let at = text.indexOf(marker);
  while (at >= 0) {
    count += 1;
    at = text.indexOf(marker, at + marker.length);
  }
  return count;
}

/**
 * The raw body text a captured row carries, or null. `readCaptureLog` attaches
 * `raw_body_text` as a non-enumerable property, so the raw capture text never
 * enters the evidence JSON; a caller that built rows itself may pass `raw_body`.
 * The mock route's log carries parsed messages and body hashes, not raw text, so
 * it returns null there and the verdict records the limit.
 * @param {unknown} row
 * @returns {string|null}
 */
export function rawBodyTextOf(row) {
  if (row === null || typeof row !== 'object') return null;
  if (typeof row.raw_body_text === 'string') return row.raw_body_text;
  if (typeof row.raw_body === 'string') return row.raw_body;
  return null;
}

/**
 * The raw-body half of the absence proof, and the limit when no raw bytes were
 * captured.
 *
 * The decoded scan reads every JSON string value. A fragment can still sit in
 * the raw body where no decoded string value explains it — a JSON property key,
 * for one — so when a row carries its raw text, every removed fragment's UTF-8
 * bytes are counted there and compared with the count in the decoded strings.
 * An occurrence the decoded strings do not account for fails the request. A
 * re-encoded fragment (base64, percent, another charset) occurs in neither, so
 * it passes; the verdict's `scope.kind` stays `decoded-string` and the claim
 * label says so instead of implying a raw-byte proof.
 *
 * Each fragment carries its sha256, so the claim line names the exact bytes the
 * absence check used, not a path or a description.
 *
 * **The verdict cannot pass without the search running.** `pass` is true only
 * when at least one fragment was named and at least one row carried raw body
 * text; when fragments are named but no raw body exists the verdict is
 * `measured: false` with `status: 'not-applicable'`, never a vacuous pass
 * (`docs/guides/law-verification-non-vacuity.md`). With no fragment named the
 * row is `absent`: a check that names nothing has no subject.
 * @param {unknown} requests rows carrying `messages` and optionally raw text
 * @param {string | readonly string[]} removed
 * @returns {{pass: boolean, measured: boolean,
 *   status: 'absent'|'not-applicable'|'pass'|'fail', kind: 'decoded-string',
 *   requests: number, rawBodyRows: number,
 *   fragments: {sha256: string, bytes: number}[],
 *   unexplained: {seq: unknown, markers: string[]}[],
 *   perRequest: {seq: unknown, carried: boolean, unexplainedMarkers: string[]}[],
 *   note: string}}
 */
export function rawBodyAbsenceVerdict(requests, removed) {
  const needles = markersOf(removed);
  const rows = Array.isArray(requests) ? requests : [];
  const fragments = needles.map((marker) => ({
    sha256: createHash('sha256').update(marker, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(marker, 'utf8'),
  }));
  const perRequest = [];
  const unexplained = [];
  let rawBodyRows = 0;
  for (const [index, row] of rows.entries()) {
    const seq = row !== null && typeof row === 'object' && row.seq !== undefined
      ? row.seq : index + 1;
    const raw = rawBodyTextOf(row);
    if (raw === null) {
      perRequest.push({ seq, carried: false, unexplainedMarkers: [] });
      continue;
    }
    rawBodyRows += 1;
    const messages = messagesOf(row);
    const decoded = messages === null ? [] : stringsOf(messages);
    const unaccounted = needles.filter((needle) => occurrencesOf(raw, needle)
      > decoded.reduce((sum, text) => sum + occurrencesOf(text, needle), 0));
    if (unaccounted.length > 0) unexplained.push({ seq, markers: unaccounted });
    perRequest.push({ seq, carried: true, unexplainedMarkers: unaccounted });
  }
  let note = 'no removed fragment was named, so no raw-body search ran';
  if (needles.length > 0 && rawBodyRows === 0) {
    note = 'this capture carries no raw body bytes, so no raw-body search ran and a re-encoded body '
      + 'is not covered';
  } else if (needles.length > 0 && rawBodyRows === rows.length) {
    note = `the removed fragment's UTF-8 bytes were also searched in the raw body text of all `
      + `${String(rows.length)} request(s)`;
  } else if (needles.length > 0) {
    note = `the removed fragment's UTF-8 bytes were also searched in the raw body text of `
      + `${String(rawBodyRows)} of ${String(rows.length)} request(s); the other `
      + `${String(rows.length - rawBodyRows)} carry no raw body bytes`;
  }
  return {
    pass: needles.length > 0 && rawBodyRows > 0 && unexplained.length === 0,
    measured: needles.length > 0 && rawBodyRows > 0,
    status: needles.length === 0
      ? 'absent'
      : (rawBodyRows === 0
        ? 'not-applicable'
        : (unexplained.length === 0 ? 'pass' : 'fail')),
    kind: 'decoded-string',
    requests: rows.length,
    rawBodyRows,
    fragments,
    unexplained,
    perRequest,
    note,
  };
}

/**
 * The scope sentence a removal claim carries: decoded-string absence, what the
 * raw-body search covered, and the exact fragment hashes. A reader must never
 * take the check for a raw-byte proof of absence, and a capture without raw
 * bytes must record that limit rather than imply the search ran.
 *
 * **A recorded compaction scopes the search to the measured segment.** When the
 * caller searched only the rows through the measured segment's end,
 * `scope.measuredSegment` names the bound and the excluded request count, so the
 * label never implies a whole-run raw search the caller did not make (the 1h
 * host checkpoint re-carries removed result text after the boundary; the
 * product has no seam into it).
 * @param {{rawBodyRows?: number, requests?: number,
 *   fragments?: {sha256?: string}[],
 *   measuredSegment?: {throughSeq?: number|null, excludedRequests?: number,
 *     boundarySeqs?: number[]}|null}|null} scope
 * @returns {string}
 */
export function removalAbsenceScopeLabel(scope) {
  const rawRows = Number(scope?.rawBodyRows ?? 0);
  const total = Number(scope?.requests ?? 0);
  const leaks = Array.isArray(scope?.unexplained) ? scope.unexplained : [];
  const leakNote = leaks.length === 0
    ? ''
    : `; the raw body carries the fragment where no decoded string explains it at `
      + `request(s) ${leaks.map((row) => String(row?.seq)).join(', ')}`;
  const hashes = (Array.isArray(scope?.fragments) ? scope.fragments : [])
    .map((row) => row?.sha256)
    .filter((hash) => typeof hash === 'string' && hash.length > 0);
  const fragmentNote = hashes.length === 0
    ? ''
    : `; removed fragment sha256 ${hashes[0]}`
      + (hashes.length > 1 ? ` (+${String(hashes.length - 1)} more)` : '');
  /**
   * The segment sentence. `throughSeq` and `boundarySeqs` are what a reader
   * needs to find the boundary; `excludedRequests` says how many bodies were
   * outside the search. With no measuredSegment record the old whole-capture
   * sentence is kept byte-for-byte.
   */
  const measured = scope?.measuredSegment ?? null;
  const segmentNote = measured === null
    ? ''
    : '; the search stops at the measured segment\'s boundary'
      + (Number.isSafeInteger(measured?.throughSeq)
        ? ` (through request ${String(measured.throughSeq)}`
        : ' (')
      + (Array.isArray(measured?.boundarySeqs) && measured.boundarySeqs.length > 0
        ? `; a host compaction at request ${measured.boundarySeqs.map(String).join(', ')} ends it`
        : '')
      + '; the '
      + `${String(Number(measured?.excludedRequests ?? 0))} later request(s) are outside the `
      + 'segment and were not searched)';
  if (hashes.length === 0) {
    return 'decoded-string absence in the parsed request bodies (a re-encoded body is not covered; '
      + 'no removed fragment was named, so no raw-body search ran)' + leakNote + segmentNote;
  }
  if (rawRows === 0) {
    return 'decoded-string absence in the parsed request bodies (a re-encoded body is not covered; '
      + 'this capture carries no raw body bytes, so no raw-body search ran)'
      + fragmentNote + leakNote + segmentNote;
  }
  if (rawRows === total) {
    return 'decoded-string absence in the parsed request bodies (a re-encoded body is not covered); '
      + `the removed fragment's UTF-8 bytes were also searched in the raw body text of all `
      + `${String(total)} request(s) (the fragment's sha256 is recorded below, not searched)`
      + fragmentNote + leakNote + segmentNote;
  }
  return 'decoded-string absence in the parsed request bodies (a re-encoded body is not covered); '
    + `the removed fragment's UTF-8 bytes were also searched in the raw body text `
    + `of ${String(rawRows)} of ${String(total)} request(s) (the fragment's sha256 is recorded `
    + `below, not searched); the other `
    + `${String(total - rawRows)} carry no raw body bytes` + fragmentNote + leakNote + segmentNote;
}

/**
 * True when one message is the tool result addressed to `callId`. Two shapes
 * exist: the OpenAI-compatible wire message (`role: "tool"` with
 * `tool_call_id`) and the host's stored message (a `tool-result` content part
 * whose own `id` names the call). Only a tool result counts: a call declaration
 * in an assistant message is not the result bytes.
 * @param {unknown} message
 * @param {string} callId
 */
export function toolResultAddressedTo(message, callId) {
  if (message === null || typeof message !== 'object') return false;
  if (message.role !== undefined && message.role !== 'tool') return false;
  if (message.tool_call_id === callId) return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((part) => part !== null && typeof part === 'object'
    && (part.type === 'tool-result' || part.type === 'tool_result')
    && part.id === callId);
}

/** True when a message carries a tool result: the OpenAI tool role or a tool-result part. */
export function isToolResultMessage(message) {
  if (message === null || typeof message !== 'object') return false;
  if (message.role === 'tool') return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((part) => part !== null && typeof part === 'object'
    && (part.type === 'tool-result' || part.type === 'tool_result'));
}

/**
 * The request's tool-result messages whose own strings carry `marker`. This is
 * the byte-level half of a superseded lane's proof: the removed read and its
 * twin legitimately carry the same file bytes, so the removed bytes cannot be
 * named by their content — but after the removal exactly ONE result message may
 * carry the file's sentinel. A host that re-keys the removed call id and keeps
 * both copies leaves two result messages carrying it, and this count finds them
 * without a content marker.
 *
 * **The count is not tool-name aware.** A `write` whose result echoes the bytes
 * it wrote also carries the sentinel, so a lane that counts raw carriers would
 * read the removal as failed while it reached the model. Callers that can name
 * the read tool use `sentinelResultCarriers`, which counts only results
 * addressed to a call whose tool name is allowed.
 * @param {unknown} messages
 * @param {string} marker
 * @returns {object[]}
 */
export function toolResultMessagesCarrying(messages, marker) {
  if (typeof marker !== 'string' || marker.length === 0) return [];
  const list = Array.isArray(messages) ? messages : [];
  return list.filter((message) => isToolResultMessage(message)
    && stringsOf(message).some((text) => text.includes(marker)));
}

/**
 * The tool name each call id was issued under, read from the request's own
 * assistant messages: the OpenAI-compatible `tool_calls[].function.name` and the
 * host's stored `{type: "tool-call", id, name}` part. The first name seen for a
 * call id wins; a call id with two names is ambiguous, so it is dropped from the
 * map and the caller records its result as unattributed rather than guessing.
 * @param {unknown} messages
 * @returns {Map<string, string>}
 */
export function toolCallNames(messages) {
  const names = new Map();
  const ambiguous = new Set();
  const record = (id, name) => {
    if (typeof id !== 'string' || id.length === 0
      || typeof name !== 'string' || name.length === 0) return;
    if (ambiguous.has(id)) return;
    const seen = names.get(id);
    if (seen === undefined) names.set(id, name);
    else if (seen !== name) { names.delete(id); ambiguous.add(id); }
  };
  const list = Array.isArray(messages) ? messages : [];
  for (const message of list) {
    if (message === null || typeof message !== 'object') continue;
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) record(call?.id, call?.function?.name ?? call?.name);
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part === null || typeof part !== 'object') continue;
        if (part.type === 'tool-call' || part.type === 'tool') record(part.id, part.name);
      }
    }
  }
  return names;
}

/** The call id a tool-result message answers, or null when it names none. */
export function toolResultCallId(message) {
  if (message === null || typeof message !== 'object') return null;
  if (typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0) {
    return message.tool_call_id;
  }
  if (!Array.isArray(message.content)) return null;
  const part = message.content.find((candidate) => candidate !== null
    && typeof candidate === 'object'
    && (candidate.type === 'tool-result' || candidate.type === 'tool_result')
    && typeof candidate.id === 'string' && candidate.id.length > 0);
  return part?.id ?? null;
}

/**
 * The tool-result messages carrying `marker`, split by the tool that produced
 * them.
 *
 * A file's bytes can appear in more than one tool's result: a `write` returns
 * the content it wrote, and a `read` of the same file returns the same bytes. A
 * sentinel count that ignores the tool name reads the writer's echo as a second
 * copy of the removed read. `options.toolNames` names the tools whose results
 * are the read side of the proof; only results addressed to one of those calls
 * are `carriers`.
 *
 * The exclusion is bounded by what the script issued. `options.excludedCallIds`
 * names the call ids the script issued **under a non-read tool**. A carrier
 * under any other call id — including a call id the script issued as a read, or
 * one it never issued — counts whatever tool name its request declares: a
 * re-keyed removed result could label itself `write` to escape a name-only
 * exclusion, and a name alone does not prove the echo. With no `excludedCallIds`
 * supplied, no carrier is excluded — the safe reading.
 *
 * **One call id has one own result.** A re-keyed removed result can be addressed
 * to a call id the script *did* issue as a write. The first marker-carrying
 * result under that id is treated as the call's own result and excluded; every
 * further result under the same id is counted as a read-side carrier. A request
 * carries one result per call, so a second result under the script's write id is
 * not that call's result however it is labelled, and a count that excluded both
 * would keep the re-keyed copy invisible.
 *
 * - `excluded` are carriers whose call id the caller named as issued under a
 *   non-read tool (the script's own write echo) and that are the **first**
 *   marker-carrying result for that id.
 * - `carriers` are results addressed to an allowed read tool, plus any second
 *   or later marker-carrying result under an excluded call id (recorded with
 *   `secondUnderCallId: true`).
 * - `unattributed` are carriers whose call id names no tool in the request,
 *   names two, or is not in `excludedCallIds`. They are not dropped: the caller
 *   counts them as read-side, so an unattributable carrier can fail the count
 *   but can never make a second copy of the removed bytes invisible.
 * @param {unknown} messages
 * @param {string} marker
 * @param {{toolNames?: string[]|Set<string>, excludedCallIds?: string[]|Set<string>}} [options]
 * @returns {{carriers: {callId: string|null, toolName: string|null,
 *     secondUnderCallId?: boolean}[],
 *   excluded: {callId: string|null, toolName: string|null}[],
 *   unattributed: {callId: string|null, toolName: string|null}[],
 *   names: Record<string, string>}}
 */
export function sentinelResultCarriers(messages, marker, options = {}) {
  const empty = { carriers: [], excluded: [], unattributed: [], names: {} };
  if (typeof marker !== 'string' || marker.length === 0) return empty;
  const allowed = options.toolNames instanceof Set
    ? options.toolNames
    : new Set(Array.isArray(options.toolNames) ? options.toolNames : []);
  const excludedIds = options.excludedCallIds instanceof Set
    ? options.excludedCallIds
    : new Set(Array.isArray(options.excludedCallIds) ? options.excludedCallIds : []);
  const list = Array.isArray(messages) ? messages : [];
  const names = toolCallNames(list);
  const carriers = [];
  const excluded = [];
  const unattributed = [];
  // The call ids whose own (first) marker-carrying result was already excluded.
  const ownResultSeen = new Set();
  for (const message of list) {
    if (!isToolResultMessage(message)) continue;
    if (!stringsOf(message).some((text) => text.includes(marker))) continue;
    const callId = toolResultCallId(message);
    const toolName = callId === null ? null : (names.get(callId) ?? null);
    if (toolName !== null && allowed.has(toolName)) {
      carriers.push({ callId, toolName });
      continue;
    }
    if (toolName !== null && callId !== null && excludedIds.has(callId)) {
      if (!ownResultSeen.has(callId)) {
        ownResultSeen.add(callId);
        excluded.push({ callId, toolName });
      } else {
        // The script issued this call id under a non-read tool, but a call has
        // one result. This second one is not that call's own result; counting
        // it is what makes a re-keyed removed result visible.
        carriers.push({ callId, toolName, secondUnderCallId: true });
      }
      continue;
    }
    unattributed.push({ callId, toolName });
  }
  return { carriers, excluded, unattributed, names: Object.fromEntries(names) };
}

/**
 * True when every marker appears in the request's own body, receipts excluded.
 * Unlike `removalBodies`'s `carriesRemoved` (one marker is enough for
 * "something of this unit is here"), this is the presence half of the positive
 * control: every marker the unit owns must be on the wire before its trigger.
 * @param {unknown} row
 * @param {string|readonly string[]} markers
 */
export function markersAllPresent(row, markers) {
  const needles = markersOf(markers);
  if (needles.length === 0) return false;
  const messages = messagesOf(row);
  if (messages === null) return false;
  const strings = stringsOf(messages.filter((message) => !isAdapterReceiptMessage(message)));
  return needles.every((needle) => strings.some((text) => text.includes(needle)));
}

/**
 * The surviving-twin result check for one request's messages. Every call id
 * must have a tool-result message addressed to it, and every marker must appear
 * inside that message's own strings. A marker that also appears in the write
 * call's arguments cannot satisfy this: the arguments are not the result.
 * @param {unknown[]} messages
 * @param {{callId: string, markers: string[]}[]} twinResults
 */
export function twinResultVerdict(messages, twinResults) {
  const list = Array.isArray(messages) ? messages : [];
  const rows = [];
  const failures = [];
  for (const twin of twinResults) {
    const addressed = list.filter((message) => toolResultAddressedTo(message, twin.callId));
    const strings = stringsOf(addressed);
    const missing = twin.markers.filter(
      (marker) => !strings.some((text) => text.includes(marker)),
    );
    const present = addressed.length > 0 && missing.length === 0;
    rows.push({ callId: twin.callId, markers: [...twin.markers],
      resultMessages: addressed.length, missing, present });
    if (addressed.length === 0) {
      failures.push(`the surviving twin ${JSON.stringify(twin.callId)} has no tool-result `
        + 'message addressed to it; a call id alone does not prove its result reached the wire'
        + (twin.markers.length === 0 ? ''
          : ` (it must carry ${twin.markers.map((marker) => JSON.stringify(marker)).join(', ')})`));
    } else if (missing.length > 0) {
      failures.push(`the tool result addressed to ${JSON.stringify(twin.callId)} does not carry `
        + missing.map((marker) => JSON.stringify(marker)).join(', '));
    }
  }
  return { pass: failures.length === 0, rows, failures };
}

/** The `twinResults` option, normalised and validated. */
function twinResultsOf(value) {
  if (!Array.isArray(value)) return [];
  const rows = [];
  for (const twin of value) {
    if (twin === null || typeof twin !== 'object' || typeof twin.callId !== 'string'
      || twin.callId.length === 0) continue;
    rows.push({ callId: twin.callId, markers: markersOf(twin.markers ?? []) });
  }
  return rows;
}

/**
 * The corrected check.
 * @param {unknown} requests
 * @param {string | readonly string[]} removed
 * @param {{survives?: string | readonly string[],
 *   twinResults?: {callId: string, markers: string[]}[],
 *   receiptMarkers?: string | readonly string[],
 *   receiptContentMarkers?: string | readonly string[]}} [options]
 * @returns {{
 *   pass: boolean,
 *   perRequest: {seq: unknown, receiptMessages: number, carriesRemoved: boolean,
 *     carriesSurviving: boolean, missingSurvivors: string[],
 *     twinResults: object[], stringsVisited: number,
 *     rawBody: {seq: unknown, carried: boolean, unexplainedMarkers: string[]}}[],
 *   failures: {seq: unknown, why: string}[],
 *   scope: ReturnType<typeof rawBodyAbsenceVerdict>,
 *   statement: string,
 * }}
 */
export function removalBodies(requests, removed, options = {}) {
  const needles = markersOf(removed);
  const survives = markersOf(options.survives ?? []);
  const twinResults = twinResultsOf(options.twinResults);
  const receiptMarkers = markersOf(options.receiptMarkers ?? []);
  const receiptContentMarkers = markersOf(options.receiptContentMarkers ?? []);
  const receiptPolicy = { markers: receiptMarkers, contentMarkers: receiptContentMarkers };
  const rows = Array.isArray(requests) ? requests : [];
  const rawVerdict = rawBodyAbsenceVerdict(rows, needles);
  if (needles.length === 0) {
    return {
      pass: false,
      perRequest: [],
      failures: [],
      scope: rawVerdict,
      statement: 'removal-bodies: no removed content was named, so the check cannot prove a removal',
    };
  }
  if (rows.length === 0) {
    return {
      pass: false,
      perRequest: [],
      failures: [],
      scope: rawVerdict,
      statement: 'removal-bodies: no request was captured, so no body proves a removal',
    };
  }
  const perRequest = [];
  const failures = [];
  for (const [index, row] of rows.entries()) {
    const seq = row !== null && typeof row === 'object' && row.seq !== undefined
      ? row.seq : index + 1;
    const rawBody = rawVerdict.perRequest[index];
    const messages = messagesOf(row);
    if (messages === null) {
      perRequest.push({
        seq, receiptMessages: 0, carriesRemoved: false,
        carriesSurviving: false, missingSurvivors: [...survives],
        twinResults: twinResults.map((twin) => ({ callId: twin.callId,
          markers: [...twin.markers], resultMessages: 0,
          missing: [...twin.markers], present: false })),
        stringsVisited: 0, rawBody,
      });
      failures.push({ seq, why: 'the row carries no request body, so the rule cannot check it' });
      if (rawBody?.unexplainedMarkers.length > 0) {
        failures.push({
          seq,
          why: 'the removed fragment is in the raw request body where no decoded string explains '
            + 'it, so the row carries the removed bytes without a body the rule can read',
        });
      }
      continue;
    }
    const scoped = messages.filter((message) => !isAdapterReceiptMessage(message));
    const scopedStrings = stringsOf(scoped);
    // The removed-byte scan reads every message, receipts included; only an
    // adapter receipt's own record line and id are allowed through, and a
    // record line carrying one of the removed markers is not allowed. A tool
    // result that quotes a receipt line, a user message with extra text, or a
    // restored archive has no adapter record, so it is scanned whole
    // (audit finding 9).
    const strings = messages.flatMap((message) => removedScanStringsOf(message, receiptPolicy));
    const expectedStrings = messages.reduce(
      (sum, message) => sum + independentScanCount(message, receiptPolicy), 0);
    /**
     * A content marker inside a receipt is removed bytes, however the receipt
     * was shaped. Content markers are file bytes, never a path or a node id, so
     * there is no slot the product's receipt line owns where one may sit. The
     * scan above catches one when the marker is also a removed marker; this
     * catches a marker the caller named only as a receipt content marker (a
     * lane's unit file sentinel, which cannot be a body-wide removed marker
     * because the surviving twin legitimately carries the same bytes).
     */
    const receiptCarriesContent = receiptContentMarkers.length > 0 && messages.some(
      (message) => isReceiptMessage(message)
        && receiptContentMarkers.some((marker) => stringsOf(message).some(
          (text) => text.includes(marker),
        )),
    );
    const carriesRemoved = receiptCarriesContent
      || needles.some((needle) => strings.some((text) => text.includes(needle)));
    const missingSurvivors = survives.filter(
      (marker) => !scopedStrings.some((text) => text.includes(marker)),
    );
    const twinVerdict = twinResultVerdict(scoped, twinResults);
    const receiptMessages = typeof row?.receipt_messages === 'number'
      ? row.receipt_messages
      : messages.filter(isReceiptMessage).length;
    const receiptShape = messages.map((message) => receiptShapeProblem(message))
      .filter((problem) => problem !== null);
    perRequest.push({
      seq, receiptMessages, carriesRemoved,
      carriesSurviving: (survives.length > 0 || twinResults.length > 0)
        && missingSurvivors.length === 0 && twinVerdict.pass,
      missingSurvivors, twinResults: twinVerdict.rows, stringsVisited: strings.length, rawBody,
    });
    if (strings.length !== expectedStrings) {
      failures.push({
        seq,
        why: `the marker scan visited ${String(strings.length)} of ${String(expectedStrings)} `
          + 'string(s) in the body, so a shallow walk could hide the removed bytes',
      });
      continue;
    }
    for (const problem of receiptShape) failures.push({ seq, why: problem });
    if (carriesRemoved) {
      const claimed = receiptMessages > 0
        ? ` and ${String(receiptMessages)} receipt message(s), so a receipt claims a removal the body contradicts`
        : '';
      failures.push({ seq, why: `the removed bytes are still in the request body${claimed}` });
    }
    if (rawBody?.unexplainedMarkers.length > 0) {
      failures.push({
        seq,
        why: 'the removed fragment is in the raw request body where no decoded string explains it '
          + '(a property key or another raw carrier), so the decoded-string scan alone is not the '
          + 'whole body',
      });
    }
    if (missingSurvivors.length > 0) {
      failures.push({
        seq,
        why: 'the surviving twin is absent from the request body: missing '
          + missingSurvivors.map((marker) => JSON.stringify(marker)).join(', ')
          + '. A body that lost both the removed unit and its twin proves no removal',
      });
    }
    for (const why of twinVerdict.failures) failures.push({ seq, why });
  }
  const twinNote = survives.length === 0 && twinResults.length === 0
    ? 'no surviving-twin marker was named, so the twin half was not checked'
    : `every request carried the ${String(survives.length)} surviving-twin marker(s) and `
      + `${String(twinResults.length)} twin tool-result message(s)`;
  const scopeNote = removalAbsenceScopeLabel(rawVerdict);
  if (failures.length === 0) {
    const receipts = perRequest.reduce((sum, row) => sum + row.receiptMessages, 0);
    return {
      pass: true,
      perRequest,
      failures,
      scope: rawVerdict,
      statement: `removal-bodies: all ${String(perRequest.length)} request(s) carry none of the `
        + `removed bytes as a decoded string; ${twinNote}; every string was visited; `
        + `${String(receipts)} receipt message(s) reported, not trusted; ${scopeNote}`,
    };
  }
  return {
    pass: false,
    perRequest,
    failures,
    scope: rawVerdict,
    statement: 'removal-bodies: '
      + failures.map((failure) => `request ${String(failure.seq)} ${failure.why}`).join('; ')
      + `; ${scopeNote}`,
  };
}
