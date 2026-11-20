/**
 * The product's receipt line, read in one place.
 *
 * Two bench files need the same answer to "is this message a receipt, and which
 * recall id does it name": `removal-bodies.mjs` excludes receipts from the scan
 * for removed bytes, and `opencode-mock-model.mjs` counts them and records their
 * recall ids as wire evidence. Before this module each file carried its own
 * markers, so a wording change in the product's line had to be mirrored by hand.
 * Now there is one predicate (`isReceiptMessage`) and one parser
 * (`receiptRecallIds`); both files import them, and a test asserts the marker
 * literals appear in this file only.
 *
 * **The structural markers the product actually writes.** No prose is parsed
 * beyond the product's own fixed shapes:
 *
 *   - `packages/core/src/rules/assets.ts` `receiptLine` renders
 *     `[not retained] <target><span><about> · necromancy <recall id>`;
 *     `packages/adapters/opencode/src/apply.ts` inserts the pass segment the
 *     receipt carries, ` · pass <intent id>`, before that marker, so the line
 *     names the applied pass that wrote it (ISSUE-256 item 1);
 *   - `packages/core/src/rules/assets.ts` `negativeFact` renders a line that
 *     starts `[search: <target>]` — a product-inserted negative fact, not a
 *     prompt;
 *   - `packages/adapters/opencode/src/apply.ts` marks its inserted receipt with
 *     `racoonsRecordId: racoons-record:<intentId>:<n>` and the same string as
 *     the message `id` (the second carrier `snapshot.ts` also reads).
 *
 * The recall id is the one token after the product's own command word in a
 * receipt line. The parser is deliberately message-level and the predicate is
 * deliberately structural (a field, an id prefix, a line prefix plus the marker
 * line), so a host that rebuilds the array and drops the marker fields still
 * yields a receipt from its text — and a tool result that merely mentions the
 * command word is still an ordinary result, not an invisible receipt.
 *
 * **The exemption is a wire shape, not a marker field.** opencode's wire
 * serialization keeps only `role` and `content` on a user receipt, so the
 * adapter's `racoonsRecordId` and `racoons-record:` id may be absent by the time
 * the bench reads the body. A message is an adapter receipt when it is a
 * user-role message whose entire text is one or more exact receipt lines, each
 * `[not retained] <target> · necromancy <recall id>` optionally with
 * ` · pass <intent id>` before the recall marker, and it carries no tool call,
 * no tool result id and no other content. A marker field remains sufficient when
 * it is present. Every message that does not meet that exact shape is scanned
 * whole: a tool result that quotes a receipt line, a user message carrying a
 * receipt line plus any other text, and a restored archive are all ordinary
 * messages for the removed-byte scan (`isAdapterReceiptMessage`).
 *
 * **A bare `necromancy` token is not a receipt.** The earlier predicate treated
 * any message whose text contained `necromancy <token>` as a receipt, and the
 * body scan excludes receipts, so a tool result that quoted the command word
 * became invisible to the removal check. A receipt is now recognised only by
 * the product's own shapes: the `racoonsRecordId` marker field, the
 * `racoons-record:` id prefix, a negative-fact line, or a line that starts with
 * `[not retained]` and carries the `· necromancy <recall id>` marker.
 */

/** The first token of every receipt line the product renders. */
export const RECEIPT_PREFIX = '[not retained]';
/** The command name the receipt line ends with, then the recall id. */
export const RECALL_COMMAND = 'necromancy';
/**
 * The command word the receipt line carries before its recall marker, then the
 * intent id of the pass that wrote the receipt (ISSUE-256 item 1).
 */
export const PASS_COMMAND = 'pass';
/** The marker field a receipt message carries. */
export const RECORD_ID_FIELD = 'racoonsRecordId';
/** Every receipt id starts here. */
export const RECORD_ID_PREFIX = 'racoons-record:';
/**
 * The adapter's other two receipt fields (`apply.ts`): the ledger record the
 * receipt renders, and the node the entry replaced. The second one is a node id
 * and therefore contains the removed call id — the receipt naming the unit it
 * replaced is the product's own pointer, not the unit still being there.
 */
export const RECEIPT_OF_FIELD = 'racoonsReceiptOf';
export const FORGOTTEN_NODE_FIELD = 'racoonsForgottenNodeId';
/** The first token of every negative-fact line the product renders. */
export const NEGATIVE_FACT_PREFIX = '[search:';
/**
 * The marker that closes a receipt line: the middle dot, the command word and
 * the recall id. A line that starts `[not retained]` without this marker is not
 * the product's receipt (a tool result may quote the prefix too).
 */
export const RECEIPT_MARKER_PATTERN = /·\s*necromancy\s+(\S+)/u;
/** The same marker, global, for parsing every id a receipt line names. */
const RECEIPT_MARKER_GLOBAL = /·\s*necromancy\s+(\S+)/gu;
/**
 * The longest receipt line the product can render. The product collapses path,
 * ranges and label to one line (`oneLine`), so a receipt line is one line; this
 * bound is the length beyond which a "receipt line" is not the product's shape
 * and may be carrying the removed bytes inside its own target. A receipt that
 * exceeds it is a named failure, not an invisible message.
 */
export const RECEIPT_LINE_MAX_CHARS = 2048;
/** The longest record id the adapter writes (`racoons-record:<intentId>:<n>`). */
export const RECORD_ID_MAX_CHARS = 256;
/** True when a text is the product's receipt line: its prefix AND its marker. */
export function isReceiptLineText(text) {
  return typeof text === 'string'
    && (text.startsWith(NEGATIVE_FACT_PREFIX)
      || (text.startsWith(RECEIPT_PREFIX) && RECEIPT_MARKER_PATTERN.test(text)));
}
/** The receipt line the product renders; the one wording this module mirrors. */
export function receiptLineText(target, recallId, span = '', about = '', passId = '') {
  const pass = typeof passId === 'string' && passId.length > 0
    ? ` · ${PASS_COMMAND} ${String(passId)}` : '';
  return `${RECEIPT_PREFIX} ${String(target)}${String(span)}${String(about)}${pass} · `
    + `${RECALL_COMMAND} ${String(recallId)}`;
}

/** Split a text into lines on the three separators a JSON string can carry. */
function linesOfText(text) {
  return text.split(/\r\n|\n|\u2028|\u2029/u);
}

/**
 * True when one line is exactly the receipt line the adapter writes:
 * `[not retained] <target> · necromancy <recall id>`, optionally with
 * ` · pass <intent id>` immediately before the recall marker, and nothing after
 * the recall id. A line with another receipt marker, a trailing segment, an
 * empty target, a newline or more chars than the product can render is not the
 * adapter's shape.
 * @param {string} text
 * @returns {boolean}
 */
export function isWireReceiptLine(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (!text.startsWith(`${RECEIPT_PREFIX} `)) return false;
  if (text.length > RECEIPT_LINE_MAX_CHARS) return false;
  if (/[\r\n\u2028\u2029]/u.test(text)) return false;
  // Exactly one recall marker, and it must close the line.
  const markers = [...text.matchAll(RECEIPT_MARKER_GLOBAL)];
  if (markers.length !== 1) return false;
  const marker = markers[0];
  if (marker.index + marker[0].length !== text.length) return false;
  // The target the product names, not an empty or blank slot.
  if (text.slice(0, marker.index).trimEnd().length <= RECEIPT_PREFIX.length) return false;
  // The pass segment is optional and only in the one position the adapter
  // inserts it; a misplaced, doubled or id-less one is not the adapter's line.
  const pass = receiptPassOfLine(text);
  return pass.status === 'named' || pass.status === 'absent';
}

/**
 * True when a text is one or more exact receipt lines and nothing else: no
 * other text, no blank line, no leading or trailing content.
 * @param {string} text
 * @returns {boolean}
 */
export function isWireReceiptText(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return linesOfText(text).every((line) => isWireReceiptLine(line));
}

/**
 * The text a wire message's `content` renders, or null when the content is not
 * plain text. A string is the wire shape; an array qualifies only when every
 * part is a text part with no id, so a tool call or tool result is never
 * mistaken for a receipt.
 * @param {unknown} content
 * @returns {string|null}
 */
function wireTextOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const texts = [];
  for (const part of content) {
    if (part === null || typeof part !== 'object' || Array.isArray(part)) return null;
    if (part.type !== 'text' || typeof part.text !== 'string') return null;
    if (part.id !== undefined) return null;
    texts.push(part.text);
  }
  return texts.join('');
}

/**
 * True when a message is a receipt the adapter could have written and the host
 * then serialized to the wire: a user-role message whose entire text is one or
 * more exact receipt lines, carrying no tool call, no tool result id and no
 * other content. The target slot is the product's pointer, so it may name the
 * unit the receipt replaced.
 * @param {unknown} message
 * @returns {boolean}
 */
export function isWireReceiptMessage(message) {
  if (message === null || typeof message !== 'object') return false;
  if (message.role !== 'user') return false;
  if (message.tool_call_id !== undefined && message.tool_call_id !== null) return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false;
  if (message.function_call !== undefined && message.function_call !== null) return false;
  const text = wireTextOfContent(message.content);
  return text !== null && isWireReceiptText(text);
}

/** A message's text, whichever shape its `content` takes. */
export function textOfMessage(message) {
  if (message === null || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

/**
 * True when one message is a product-inserted record: a receipt (by marker
 * field, id prefix, or the receipt line's own prefix) or a negative fact.
 * @param {unknown} message
 * @returns {boolean}
 */
export function isReceiptMessage(message) {
  if (message === null || typeof message !== 'object') return false;
  const marker = message[RECORD_ID_FIELD];
  if (typeof marker === 'string' && marker.startsWith(RECORD_ID_PREFIX)) return true;
  const id = message.id;
  if (typeof id === 'string' && id.startsWith(RECORD_ID_PREFIX)) return true;
  return isReceiptLineText(textOfMessage(message));
}

/**
 * True when a message is the adapter's own inserted record: it carries the
 * adapter's marker (`racoonsRecordId` or a `racoons-record:` message id), or it
 * has the exact wire shape the host serializes a receipt to (`isWireReceiptMessage`).
 * The marker stays sufficient when a host keeps it. The wire shape is what makes
 * a receipt exempt after a host rebuild drops the marker fields: a tool result
 * that quotes a receipt line has no user role and no marker, so it is still
 * scanned, and a user message carrying any other text is not the wire shape.
 * @param {unknown} message
 * @returns {boolean}
 */
export function isAdapterReceiptMessage(message) {
  if (message === null || typeof message !== 'object') return false;
  const marker = message[RECORD_ID_FIELD];
  if (typeof marker === 'string' && marker.startsWith(RECORD_ID_PREFIX)) return true;
  const id = message.id;
  if (typeof id === 'string' && id.startsWith(RECORD_ID_PREFIX)) return true;
  return isWireReceiptMessage(message);
}

/**
 * The recall ids a receipt line's marker names, in first-seen order. Only the
 * `· necromancy <recall id>` marker is parsed: the receipt's own target/about
 * text may mention the command word, and that mention is not a record.
 * @param {string} text
 * @returns {string[]}
 */
export function receiptRecallIdsOfLine(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const ids = [];
  for (const match of text.matchAll(RECEIPT_MARKER_GLOBAL)) {
    if (match[1] !== undefined && match[1].length > 0 && !ids.includes(match[1])) {
      ids.push(match[1]);
    }
  }
  return ids;
}

/**
 * One `· pass` marker, whether or not an id follows it. The lookahead keeps a
 * label that merely starts a word with `pass` (`· passage`) out of the count.
 */
const PASS_MARKER_GLOBAL = /·\s*pass(?=\s|$)/gu;
/** The writer's segment: the line's head ends on ` · pass <intent id>`. */
const PASS_TRAILING_PATTERN = /(?:^|\s)·\s*pass\s+(\S+)\s*$/u;
/** Every pass id a line names, in first-seen order. */
const PASS_TOKEN_GLOBAL = /·\s*pass\s+(\S+)/gu;

/**
 * The pass a receipt line names, or why it names none.
 *
 * The product's line is
 * `[not retained] <target><span><about> · pass <intent id> · necromancy <recall id>`
 * (`packages/adapters/opencode/src/apply.ts` inserts the pass before the
 * ledger's own trailing marker). The parse is positional: the pass segment must
 * be the head's trailing segment. A `· pass` token anywhere else — after the
 * recall id, or a second one inside the label — is not the writer's shape and
 * is reported `malformed` or `ambiguous`, never read as a pass.
 *
 * `absent` is the older writer: the receipt is the product's line and carries
 * no pass. A caller must treat that as "no pass named" — a refusal — and never
 * assume the pass from request order.
 *
 * @typedef {{status: 'named', passId: string}
 *   | {status: 'absent'}
 *   | {status: 'not-a-receipt'}
 *   | {status: 'ambiguous', passIds: string[]}
 *   | {status: 'malformed'}} ReceiptPass
 * @param {string} text
 * @returns {ReceiptPass}
 */
export function receiptPassOfLine(text) {
  if (typeof text !== 'string' || !isReceiptLineText(text)) return { status: 'not-a-receipt' };
  const marker = RECEIPT_MARKER_PATTERN.exec(text);
  const markerAt = marker === null ? -1 : marker.index;
  const head = markerAt < 0 ? text : text.slice(0, markerAt);
  const tail = markerAt < 0 ? '' : text.slice(markerAt);
  const headMarkers = [...head.matchAll(PASS_MARKER_GLOBAL)];
  // The pass belongs to the head, before the recall marker. A pass token after
  // it is not the line the product writes.
  if ((tail.match(PASS_MARKER_GLOBAL) ?? []).length > 0) return { status: 'malformed' };
  if (headMarkers.length === 0) return { status: 'absent' };
  const tokens = [...head.matchAll(PASS_TOKEN_GLOBAL)]
    .map((match) => match[1])
    .filter((id) => id !== undefined && id.length > 0);
  if (headMarkers.length > 1) {
    return tokens.length === headMarkers.length
      ? { status: 'ambiguous', passIds: tokens }
      : { status: 'malformed' };
  }
  const trailing = PASS_TRAILING_PATTERN.exec(head);
  if (trailing === null || trailing[1] === undefined || trailing[1].length === 0) {
    return { status: 'malformed' };
  }
  return { status: 'named', passId: trailing[1] };
}

/**
 * The pass id a receipt line names, or null when it names none. The strict
 * reader is {@link receiptPassOfLine}: this helper is for a caller that only
 * needs the id and treats every non-`named` answer as absence.
 * @param {string} text
 * @returns {string|null}
 */
export function receiptPassIdOfLine(text) {
  const parsed = receiptPassOfLine(text);
  return parsed.status === 'named' ? parsed.passId : null;
}

/**
 * True when a marker appears more than once in a text.
 * @param {string} text
 * @param {string} marker
 */
function occurrences(text, marker) {
  let count = 0;
  let at = text.indexOf(marker);
  while (at >= 0) {
    count += 1;
    at = text.indexOf(marker, at + marker.length);
  }
  return count;
}

/**
 * True when a receipt line carries a marker in a position the product's line
 * does not own.
 *
 * The product's line names the unit it replaced in its **target** slot — for a
 * tool unit that target is the node id `oc:…:tool:<call id>` — so a bare "the
 * line contains the call id" check would reject every real receipt. The target
 * is the product's own pointer: a marker there is allowed once. Every other
 * slot is not: the ranges, the `— about: <label>` text, and the text after the
 * `· necromancy <recall id>` marker must carry none of them. A marker that
 * appears twice inside the target is also a leak. A content marker is never the
 * product's pointer, so it is rejected anywhere in the line.
 * @param {string} text
 * @param {string[]} markers
 * @param {string[]} contentMarkers
 */
function receiptLineLeak(text, markers, contentMarkers) {
  if (contentMarkers.some((marker) => text.includes(marker))) return true;
  if (markers.length === 0) return false;
  const match = RECEIPT_MARKER_PATTERN.exec(text);
  const markerAt = match === null ? -1 : match.index;
  const head = markerAt < 0 ? text : text.slice(0, markerAt);
  const tail = markerAt < 0 ? '' : text.slice(markerAt);
  let target = '';
  let outside = head;
  if (head.startsWith(RECEIPT_PREFIX)) {
    const rest = head.slice(RECEIPT_PREFIX.length);
    const cuts = [rest.indexOf(' lines '), rest.indexOf(' — about: ')]
      .filter((at) => at >= 0);
    const end = cuts.length === 0 ? rest.length : Math.min(...cuts);
    target = rest.slice(0, end);
    outside = rest.slice(end);
  }
  return markers.some((marker) => tail.includes(marker) || outside.includes(marker)
    || occurrences(target, marker) > 1);
}

/**
 * The strings a receipt message is allowed to carry without being scanned for
 * removed bytes: the record id the adapter marks it with and the product's own
 * record line, at the product's shape (one line, at most
 * `RECEIPT_LINE_MAX_CHARS`). Every other string in a receipt-shaped message is
 * scanned like any other message's, so a receipt that also carries the removed
 * bytes is found instead of being excluded whole.
 *
 * The bound is what keeps the allowance from being an unbounded hole: a line
 * that is longer than the product can render is not "the product's own receipt
 * line", and a receipt carrying the removed bytes inside its target is named.
 *
 * **The allowed line is checked for the lane's own markers.** A line that is
 * structurally the product's receipt (`[not retained] … · necromancy <id>` or
 * `[search: …]`) is still a hiding place for a removed call id or content
 * marker: excluding it whole would make them invisible to the scan that looks
 * for exactly those strings. `markers` are checked outside the line's target
 * slot (and once inside it, because the target is the product's pointer);
 * `contentMarkers` are checked anywhere. The record fields are not marker-scanned:
 * the forgotten-node field is the product's own pointer to the unit it replaced,
 * and the recall id is the receipt's identity.
 *
 * **The allowance needs the adapter's record.** A message whose text merely
 * starts `[not retained] … · necromancy <id>` is a quotation unless the message
 * carries `racoonsRecordId` / a `racoons-record:` id, or has the exact wire
 * shape a user receipt serializes to (`isWireReceiptMessage`); without one,
 * `allowedReceiptString` returns false and every string of the message is
 * scanned. The text shape then only selects which string of a receipt is the
 * record line.
 * @param {unknown} message
 * @param {string} text
 * @param {string|readonly string[]|{markers?: string|readonly string[],
 *   contentMarkers?: string|readonly string[]}} [options] the markers under
 *   check; a bare list is treated as `markers`
 * @returns {boolean}
 */
export function allowedReceiptString(message, text, options = {}) {
  if (typeof text !== 'string') return false;
  // The exemption is the adapter's record, never a bare text shape: a tool
  // result that quotes the product's line has no user wire shape and stays in
  // the scan.
  if (!isAdapterReceiptMessage(message)) return false;
  if (text.startsWith(RECORD_ID_PREFIX)) return text.length <= RECORD_ID_MAX_CHARS;
  if (message === null || typeof message !== 'object') return false;
  if (typeof message.id === 'string' && text === message.id) {
    return text.length <= RECORD_ID_MAX_CHARS;
  }
  // The adapter's own marker fields and their values: the record id, the
  // receipt-of hash, and the node id the receipt replaced. The node id names
  // the unit, which is the product's pointer, not the unit's bytes.
  for (const field of [RECORD_ID_FIELD, RECEIPT_OF_FIELD, FORGOTTEN_NODE_FIELD]) {
    const value = message[field];
    if (typeof value === 'string' && text === value) return text.length <= RECORD_ID_MAX_CHARS;
  }
  const policy = options !== null && typeof options === 'object' && !Array.isArray(options)
    ? options : { markers: options };
  const asList = (value) => (Array.isArray(value) ? value : [value])
    .filter((marker) => typeof marker === 'string' && marker.length > 0);
  const markers = asList(policy.markers ?? []);
  const contentMarkers = asList(policy.contentMarkers ?? []);
  // A wire receipt may carry several receipt lines in one content string; each
  // line is checked on its own, so the target allowance does not cover a line
  // the product did not write.
  if (isWireReceiptText(text)) {
    return linesOfText(text).every((line) => !receiptLineLeak(line, markers, contentMarkers));
  }
  if (!isReceiptLineText(text)) return false;
  if (receiptLineLeak(text, markers, contentMarkers)) return false;
  return text.length <= RECEIPT_LINE_MAX_CHARS && !/[\r\n\u2028\u2029]/u.test(text);
}

/**
 * Why a receipt message's own record line is not the product's shape, or null.
 * A receipt line over the bound is a named failure: its length is where removed
 * bytes could hide inside the one part of a receipt this module allows. A text
 * that is the exact wire shape is already bounded line by line and passes. Only
 * an adapter receipt (marker or wire shape) has an allowed part; a quoted line
 * has none, so it is scanned as ordinary text instead of shape-checked.
 * @param {unknown} message
 * @returns {string|null}
 */
export function receiptShapeProblem(message) {
  if (!isAdapterReceiptMessage(message)) return null;
  const content = message.content;
  const strings = typeof content === 'string'
    ? [content]
    : (Array.isArray(content)
      ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).filter(
        (text) => text.length > 0)
      : []);
  for (const text of strings) {
    if (isWireReceiptText(text)) continue;
    if (!isReceiptLineText(text)) continue;
    if (text.length > RECEIPT_LINE_MAX_CHARS) {
      return `a receipt line is ${String(text.length)} chars; the product collapses a receipt to one `
        + `line of at most ${String(RECEIPT_LINE_MAX_CHARS)}. A line longer than that may be carrying `
        + 'the removed bytes inside its own target';
    }
    if (/[\r\n\u2028\u2029]/u.test(text)) {
      return 'a receipt line spans more than one line; the product collapses it to one line';
    }
  }
  return null;
}

/**
 * The recall ids a request's messages name, sorted and unique: one receipt is
 * one record, and a duplicate line is the same record twice. Only a message the
 * predicate recognises as a receipt is parsed, and only its marker line names
 * an id, so a tool result that mentions `necromancy <token>` contributes no
 * recall id and is not excluded from the body scan.
 * @param {unknown} messages
 * @returns {string[]}
 */
export function receiptRecallIds(messages) {
  if (!Array.isArray(messages)) return [];
  const ids = new Set();
  for (const message of messages) {
    if (!isReceiptMessage(message)) continue;
    for (const id of receiptRecallIdsOfLine(textOfMessage(message))) ids.add(id);
  }
  return [...ids].sort();
}
