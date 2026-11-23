/**
 * Snapshot derivation: the 2.4.0 request's `Message[]` → core `SessionSnapshot`
 * (ISSUE-192; ADR-0044).
 *
 * The host rebuilds the request before every model call and hands the `context`
 * hook the message list by reference, so this is a pure projection: the same
 * array twice is a deep-equal snapshot. Identity is the rule ADR-0044 records:
 * a message node is keyed by the host message id when one is present, else by
 * its position; a text/reasoning node is keyed by the position of its content
 * part; a tool-result unit is keyed by its call id.
 *
 * Mapping, one row per host element:
 *   - `user` message → one `MessageNode` (role `user`), bytes = its text parts
 *     joined in content order;
 *   - `system` message → one `MessageNode` (role `system`), bytes = its text
 *     parts joined; it opens no turn and advances no step;
 *   - assistant `text` / `reasoning` part → one `MessageNode` each, verbatim;
 *   - a `tool-call` part with exactly one matching `tool-result` part → one
 *     `ToolResultNode` positioned at the **call** part, `callId = call.id`, bytes
 *     = **the result's decoded text** (`unitBytes` → `opencodeUnitText`): the
 *     exact text the host sends for that result, and the byte space its line
 *     numbers, its ask anchors and every verdict range address. A unit used to
 *     carry the `{input,name,result}` envelope, whose JSON-escaped newlines made
 *     every unit one line and made a partial `keeplines` unaddressable
 *     (ISSUE-509). The call id names the node, not the bytes, so identical
 *     result texts hash identically. The call and result are one unit even
 *     though 2.4.0 puts them in two content parts (usually two messages);
 *   - a `tool-call` part with no result → no node; attached as evidence on the
 *     nearest node. 2.4.0 has no `pending`/`running` state, so "no result yet"
 *     is the only not-finished fact;
 *   - a `tool-result` part whose call is absent → one `ToolResultNode` at its own
 *     position, bytes = the same decoded result text (no call id and no input: no
 *     call part states them). It is projected but a plan naming it is refused
 *     `tool-pair-split`, because its pairing cannot be stated;
 *   - `media`, `effort`, `compaction`, an unknown part type, and a repeated call
 *     id → no node; evidence attached to the nearest node (the repeated call id
 *     is instead a hard error, because two units would share one node id);
 *   - a message carrying a ledger record → one `RacoonsRecordNode`; its content
 *     is not projected, so a receipt never becomes a prompt. The record is
 *     recognised by either carrier: the `racoonsRecordId` marker field, or a
 *     message whose `id` starts `racoons-record:` (`recordIdOf`). The id is the
 *     second carrier so a host that rebuilds the message and drops the marker
 *     field still has its own receipt read as a record, not as a prompt.
 *
 * Two facts the mapping leaves open, decided here and asserted in tests:
 *   - **Call declarations.** The core guard requires every tool-result node to be
 *     preceded by a message node whose `toolCallIds` names the call
 *     (`packages/core/src/guard/checks-sources.ts`). An assistant message's calls
 *     are declared on its first message node; when its first tool-call precedes
 *     every message part (or it has no message part at all), one entry-level
 *     `MessageNode` with empty bytes is emitted first to carry them.
 *   - **Ordinals.** A user message after the first opens the next turn (0-based);
 *     every assistant message is one model step. A `role: "tool"` message keeps
 *     the step of the call it answers and never advances it. Steps are global and
 *     never restart per turn, because the core requires both ordinals to be
 *     non-decreasing across the node list. No turn is ever claimed complete from
 *     this projection: the context hook fires before a model call, so the turn it
 *     belongs to is still being assembled. `completedThroughTurnOrdinal` is
 *     therefore `currentTurn - 1`, which is `-1` when no turn has completed yet
 *     (the core guard permits `-1`), unless the caller has a turn-end fact to
 *     supply. `session.idle` is that fact; the effective value is
 *     `max(suppliedFact, currentTurn - 1)`, so a stale fact never lowers the
 *     default and a fresh idle raises it.
 *
 * `revision` is `oc:<messageCount>:<digest>`. The digest covers, in emission
 * order, every node id and node hash and every emitted evidence digest — a part
 * attached to a node or left unanchored — then, also in emission order, every
 * unit's declaration digest (the two blocks are concatenated; a declaration is
 * not interleaved with the node it belongs to). A body-only update at the same
 * id moves it and the port's stale-revision refusal sees it. A unit's body is
 * the result text (ISSUE-509), so the declaration is its own digest entry: the
 * name, namespace, arguments, result tag or a dropped content entry can change
 * while the body does not.
 */

import {
  sha256Sync, splitLineOffsets, toBytes,
} from '@cremator/core';
import type {
  CacheState, MessageNode, NodeId, PathEvidence, RacoonsRecordNode,
  RetentionEvidence, Revision, SearchTarget, SessionSnapshot, Sha256, ToolEvidence,
  ToolResultNode, TranscriptNode,
} from '@cremator/core';
import { createOpencodeToolClassifier } from './classifier.js';
import type { OpencodeToolClassifier } from './classifier.js';
import { opencodeIsErrorResult } from './host.js';
import type {
  OpencodeContentPart, OpencodeMessage, OpencodeToolCallPart, OpencodeToolResultPart,
  OpencodeToolResultValue,
} from './host.js';

/**
 * The marker field a receipt message carries, naming the record the ledger also
 * holds. `commit()` writes it; this module reads it. It is an in-array marker
 * only: the host does not persist a context hook's mutation, which is exactly why
 * `rehydrateOnResume` stays false.
 */
export const OPENCODE_RECORD_ID_FIELD = 'racoonsRecordId';

/** Every receipt entry id starts here, so the projection reads it as a record. */
export const OPENCODE_RECORD_PREFIX = 'racoons-record:';

/** The prefix every derived node id carries, so a mixed array cannot alias. */
export const OPENCODE_NODE_PREFIX = 'oc';

/** `oc:<sessionId>:msg:<messageKey>` — one per message node. */
export function opencodeMessageNodeId(sessionId: string, messageKey: string): NodeId {
  return `${OPENCODE_NODE_PREFIX}:${sessionId}:msg:${messageKey}`;
}

/** `oc:<sessionId>:part:<messageKey>:<partIndex>` — one per text/reasoning part. */
export function opencodePartNodeId(
  sessionId: string, messageKey: string, partIndex: number,
): NodeId {
  return `${OPENCODE_NODE_PREFIX}:${sessionId}:part:${messageKey}:${String(partIndex)}`;
}

/** `oc:<sessionId>:tool:<callId>` — one per tool-result unit. */
export function opencodeToolNodeId(sessionId: string, callId: string): NodeId {
  return `${OPENCODE_NODE_PREFIX}:${sessionId}:tool:${callId}`;
}

/** The key a message node uses: the host id, else its position (ADR-0044). */
export function opencodeMessageKey(message: OpencodeMessage, index: number): string {
  return typeof message.id === 'string' && message.id.length > 0 ? message.id : `pos:${String(index)}`;
}

/** A content part that became no node, attached to the nearest node instead. */
export interface OpencodeAttachedEvidence {
  readonly kind: 'part';
  /** The call id for a tool part, else `p<contentIndex>`. */
  readonly partKey: string;
  readonly partType: string;
  /** `call` for a tool-call part; null for a part with no call state. */
  readonly status: string | null;
  /** The file or URL the part names, when it names one; never guessed. */
  readonly displayPath: string | null;
  /** True only for a host compaction part. */
  readonly hostCompaction: boolean;
  readonly sha256: Sha256;
  readonly byteLength: number;
}

export interface OpencodeSnapshot {
  /** The core snapshot the engine and the guard consume. */
  readonly snapshot: SessionSnapshot;
  /** Evidence keyed by the node it was attached to, in emission order. */
  readonly attached: ReadonlyMap<NodeId, readonly OpencodeAttachedEvidence[]>;
  /** Evidence with no node to attach to; reported, never silently discarded. */
  readonly unanchored: readonly OpencodeAttachedEvidence[];
}

export interface OpencodeSnapshotOptions {
  readonly sessionId: string;
  /** The mount's classifier, so evidence uses exactly the vocabulary the mount reads. */
  readonly classifier?: OpencodeToolClassifier;
  /** A turn-end fact the caller holds; defaults to `currentTurn - 1`. */
  readonly completedThroughTurnOrdinal?: number;
  readonly cache?: CacheState;
  readonly retentionEvidence?: readonly RetentionEvidence[];
}

type Emitted =
  | { readonly kind: 'node'; readonly node: TranscriptNode }
  | { readonly kind: 'evidence'; readonly evidence: OpencodeAttachedEvidence };

export interface OpencodeCallSite {
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly part: OpencodeToolCallPart;
}

export interface OpencodeResultSite {
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly part: OpencodeToolResultPart;
}

/** One call and its one result: the removal unit (ADR-0044 decision 3). */
export interface OpencodeUnit {
  readonly call: OpencodeCallSite;
  readonly result: OpencodeResultSite;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function contentOf(message: OpencodeMessage): readonly OpencodeContentPart[] {
  return Array.isArray(message.content) ? message.content : [];
}

function textOfContent(content: readonly OpencodeContentPart[]): string {
  return content
    .filter(part => part.type === 'text' && typeof part['text'] === 'string')
    .map(part => part['text'] as string)
    .join('');
}

function isMessagePart(part: OpencodeContentPart): boolean {
  return (part.type === 'text' || part.type === 'reasoning')
    && typeof part['text'] === 'string';
}

function isToolCall(part: OpencodeContentPart): part is OpencodeToolCallPart {
  return part.type === 'tool-call' && typeof part['id'] === 'string'
    && part['id'].length > 0 && typeof part['name'] === 'string';
}

function isToolResult(part: OpencodeContentPart): part is OpencodeToolResultPart {
  return part.type === 'tool-result' && typeof part['id'] === 'string'
    && part['id'].length > 0 && typeof part['name'] === 'string'
    && isRecord(part['result']) && typeof (part['result'] as Record<string, unknown>)['type'] === 'string';
}

function recordIdOf(message: OpencodeMessage): string | null {
  const value = message[OPENCODE_RECORD_ID_FIELD];
  if (typeof value === 'string' && value.startsWith(OPENCODE_RECORD_PREFIX)) return value;
  // The id is the second carrier: if a host re-builds the message and drops the
  // marker field, the adapter still reads its own receipt as a record instead of
  // a prompt. Apply's idempotency check then refuses a partial receipt by name
  // rather than appending a second one.
  const id = message.id;
  return typeof id === 'string' && id.startsWith(OPENCODE_RECORD_PREFIX) ? id : null;
}

/**
 * The call and result sites of one array, keyed by call id. A repeated call id or
 * a result that precedes its call makes the array ambiguous; this throws rather
 * than guessing. The mount's context hook catches the throw and journals
 * `transform-error`; `deriveOpencodeRevert` names the same fact
 * `tool-pair-split` when it is reached directly, but on the mount path this
 * projection runs first.
 */
function buildUnits(messages: readonly OpencodeMessage[]): {
  calls: Map<string, OpencodeCallSite>;
  results: Map<string, OpencodeResultSite>;
  units: Map<string, OpencodeUnit>;
} {
  const callSites = new Map<string, OpencodeCallSite[]>();
  const resultSites = new Map<string, OpencodeResultSite[]>();
  messages.forEach((message, messageIndex) => {
    contentOf(message).forEach((part, partIndex) => {
      if (isToolCall(part)) {
        const sites = callSites.get(part.id) ?? [];
        sites.push({ messageIndex, partIndex, part });
        callSites.set(part.id, sites);
      }
      if (isToolResult(part)) {
        const sites = resultSites.get(part.id) ?? [];
        sites.push({ messageIndex, partIndex, part });
        resultSites.set(part.id, sites);
      }
    });
  });
  const calls = new Map<string, OpencodeCallSite>();
  const results = new Map<string, OpencodeResultSite>();
  const units = new Map<string, OpencodeUnit>();
  for (const [id, sites] of callSites) {
    if (sites.length > 1) {
      throw new Error(`tool call ${id} is carried by ${String(sites.length)} call parts`);
    }
    const site = sites[0];
    if (site !== undefined) calls.set(id, site);
  }
  for (const [id, sites] of resultSites) {
    if (sites.length > 1) {
      throw new Error(`tool call ${id} is carried by ${String(sites.length)} result parts`);
    }
    const site = sites[0];
    if (site !== undefined) results.set(id, site);
  }
  for (const [id, call] of calls) {
    const result = results.get(id);
    if (result === undefined) continue;
    if (result.messageIndex < call.messageIndex
      || (result.messageIndex === call.messageIndex && result.partIndex < call.partIndex)) {
      throw new Error(`tool result ${id} precedes its call`);
    }
    units.set(id, { call, result });
  }
  return { calls, results, units };
}

/**
 * The text the host's normalizer substitutes for an empty tool result: its
 * `EMPTY_TOOL_OUTPUT` constant in `@opencode/ai`'s `dist/tool-history.js`
 * (line 2, applied at lines 86-94). An empty `text` value, an empty `error`
 * value, and a `content` array with no surviving entry all become this literal
 * before the request reaches the wire.
 */
const HOST_EMPTY_TOOL_OUTPUT = '(no tool output)';

/**
 * The exact text one tool result carries, and therefore the bytes of its unit
 * (ISSUE-509). It mirrors `opencodeResultText` in `apply.ts` tag for tag — the
 * function the containment rules and the partial-keep lowering already read:
 *
 *   - `text`: a string `value` verbatim (an empty one is the host's
 *     `(no tool output)` rewrite); a non-string is its JSON text;
 *   - `json`: always its JSON text. **A `json` result is JSON text whatever its
 *     value's type**: a string value is `"abc"`, not `abc`, because the host
 *     lowers the `json` tag with `JSON.stringify` (audit F1). Only `text`/`error`
 *     read a string verbatim;
 *   - `error`: a string verbatim (empty is the rewrite); a structured value (an
 *     object or array) is its JSON text; any other value is `String(value)`, the
 *     host's own split;
 *   - `content`: its non-empty `text` entries joined with `'\n'`, with the host's
 *     own emptiness test (no survivor is the same rewrite, and a file-only array
 *     joins to `''`);
 *   - anything else: its JSON text.
 *
 * This lives here rather than being imported from `apply.ts` because `apply.ts`
 * already imports this module: the two must not form a cycle. A snapshot test
 * pins the two decoders equal for every tag, so they cannot drift apart silently.
 *
 * **The unit body is this text, not a JSON envelope.** Line counting, the ask
 * table's `[L line(s)]`, the row anchors and every `keeplines` range are byte
 * arithmetic over the unit body (`packages/core/src/units/segmenter.ts`,
 * `packages/core/src/prune/anchor-positions.ts`). An envelope's escaped
 * newlines made every unit one line and put the anchored byte shares inside
 * `{"input":…}` (ISSUE-509). The call's name and arguments are not lost: the
 * call part states them, `toolEvidence` reads them, and the prune's `callFacts`
 * names the tool and target.
 */
export function opencodeUnitText(part: OpencodeToolResultPart): string {
  const value = part.result.value;
  if (part.result.type === 'text') {
    if (typeof value === 'string') {
      return value === '' ? HOST_EMPTY_TOOL_OUTPUT : value;
    }
    return JSON.stringify(value) ?? '';
  }
  if (part.result.type === 'json') {
    // A JSON value is always its JSON text: `'abc'` is `"abc"` on the wire.
    return JSON.stringify(value) ?? '';
  }
  if (part.result.type === 'error') {
    if (typeof value === 'string') {
      return value === '' ? HOST_EMPTY_TOOL_OUTPUT : value;
    }
    // The host's own split (`archivedResultWireText`): a bare error value is its
    // string form; an object or array is its JSON text.
    return isStructuredValue(value) ? JSON.stringify(value) ?? '' : String(value);
  }
  if (part.result.type === 'content' && Array.isArray(value)) {
    // The host's own emptiness test (tool-history.js:92): every entry that is
    // not a text entry with empty text survives, and no survivor means the
    // result is rewritten. A file entry survives, so a file-only array is not
    // this case and keeps the join's empty text.
    const survives = value.some(entry =>
      !(isRecord(entry) && entry['type'] === 'text' && entry['text'] === ''));
    if (!survives) return HOST_EMPTY_TOOL_OUTPUT;
    const texts: string[] = [];
    for (const entry of value) {
      if (isRecord(entry) && entry['type'] === 'text'
        && typeof entry['text'] === 'string' && entry['text'] !== '') {
        texts.push(entry['text']);
      }
    }
    return texts.join('\n');
  }
  return JSON.stringify(value) ?? '';
}

/** True for the object/array shapes the host serializes as JSON, never as `String(...)`. */
function isStructuredValue(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function unitBytes(unit: OpencodeUnit): Uint8Array {
  // The unit's body IS the result text the host sends (ISSUE-509): the byte space
  // its lines, its anchors and its `keeplines` ranges address. The call id names
  // the node, not the bytes, so two identical result texts hash identically.
  return toBytes(opencodeUnitText(unit.result.part));
}

function orphanResultBytes(part: OpencodeToolResultPart): Uint8Array {
  return toBytes(opencodeUnitText(part));
}

/**
 * The content entries the unit's text does not carry: a non-text entry (a file)
 * and an empty or malformed text entry are dropped from the decoded join. The
 * body cannot see them, so the revision digest does. The digest is deliberately
 * conservative here: `opencodeTextPayload` still accepts a mixed array when one
 * non-empty text entry survives, but an empty entry is treated as residue
 * anyway so the revision moves.
 */
function contentResidueText(result: OpencodeToolResultValue): string {
  if (result.type !== 'content' || !Array.isArray(result.value)) return '';
  const residue = result.value.filter(entry =>
    !(isRecord(entry) && entry['type'] === 'text'
      && typeof entry['text'] === 'string' && entry['text'] !== ''));
  return residue.length === 0 ? '' : canonicalText(residue);
}

/**
 * The declaration facts a unit's revision entry carries — the fields the result
 * text alone cannot see: the tool name and namespace on both parts, the
 * arguments, the result tag and the content entries the text drops.
 *
 * The arguments encode an ABSENT `input` differently from a present `null` or
 * `undefined`, because those are three different host requests (audit F8). The
 * tag matters because `text`→`error` with the same value turns a hit into a
 * miss, and a dropped file or empty content entry is residue the body cannot
 * see; neither moves a body byte. A result is non-carryable for a partial keep
 * only when no text entry survives, not merely because one entry is empty.
 */
function unitCallDigest(unit: OpencodeUnit): string {
  const call = unit.call.part;
  const result = unit.result.part.result;
  return sha256Sync(toBytes(JSON.stringify([
    'call',
    call.name,
    nonempty(call['namespace']),
    Object.hasOwn(call, 'input') ? canonicalText(call.input) : 'no-input-key',
    unit.result.part.name,
    nonempty(unit.result.part['namespace']),
    result.type,
    contentResidueText(result),
  ])));
}

/** The result part's own name, namespace, tag and dropped content entries. */
function orphanCallDigest(part: OpencodeToolResultPart): string {
  return sha256Sync(toBytes(JSON.stringify([
    'orphan', part.name, nonempty(part['namespace']), part.result.type,
    contentResidueText(part.result),
  ])));
}

/**
 * The call's own declared target. A read and a write name the same kind of
 * thing — the file path they touched — and take it from the same two argument
 * spellings, so the core stale-read rule compares like with like (ADR-0046). A
 * write's target is a fact about the path it changed, never a hit/miss claim.
 */
function toolTarget(
  kind: ToolEvidence['kind'], input: Readonly<Record<string, unknown>>,
): SearchTarget | null {
  const candidate = kind === 'read' || kind === 'write'
    ? nonempty(input['path']) ?? nonempty(input['filePath'])
    : kind === 'search' || kind === 'glob'
      ? nonempty(input['pattern']) ?? nonempty(input['query'])
      : null;
  return candidate === null ? null : { key: candidate, label: candidate };
}

/**
 * The host's truncation notice on a read result: the line/byte cap cut the body
 * and saved the rest to a file (or failed to). A read that carries this is not
 * a whole-file observation, so no coverage is claimed.
 *
 * 2.4.0 builds the notice from one template and can emit four forms:
 *   `[showing lines 1-N of T; full output saved to PATH]`
 *   `[showing lines 1-N (last line cut) of T; full output saved to PATH]`
 *   `[showing lines 1-N of T; full output could not be saved: ERROR]`
 *   `[showing 0 lines of T; full output saved to PATH]`
 * The match is the notice's opening and tail shape, never one full sentence:
 * a wording change in between still reads as truncation, and a truncated body
 * the adapter fails to recognise must never claim full coverage (ISSUE-536).
 */
const READ_TRUNCATION_NOTICE =
  /\[showing (?:\d+ lines?|lines \d+(?:-\d+)?)[^\]\n]*; full output /u;

/** The result's own text for the truncation notice; never a tag guess. */
function resultValueText(result: OpencodeToolResultValue): string {
  return typeof result.value === 'string'
    ? result.value : (JSON.stringify(result.value) ?? '');
}

/**
 * The coverage fact for one hit read:
 *   - the input names a range argument (`offset`/`limit`, the host read tool's
 *     range) → `'partial'`;
 *   - else the result text carries the host's truncation notice → no coverage
 *     claim (`undefined`), because a truncated body is not the whole file;
 *   - else → `'full'`.
 * A miss carries no coverage at all.
 */
function readCoverageOf(
  input: Readonly<Record<string, unknown>>, result: OpencodeToolResultPart,
): PathEvidence['coverage'] | undefined {
  if (Object.hasOwn(input, 'offset') || Object.hasOwn(input, 'limit')) return 'partial';
  if (READ_TRUNCATION_NOTICE.test(resultValueText(result.result))) return undefined;
  return 'full';
}

function toolEvidence(
  name: string, input: Readonly<Record<string, unknown>>,
  result: OpencodeToolResultPart,
  classify: OpencodeToolClassifier, source: ToolEvidence['source'],
): ToolEvidence {
  const kind = classify(name);
  // Every tool that names a path in its own arguments contributes an
  // observation, whatever its kind: the host stated it, so dropping it would
  // hide a fact. For a `write` this is the path the proof rule matches against
  // a read; for every other tool it is evidence of nothing until its kind says
  // otherwise.
  const names = new Set<string>();
  for (const candidate of [input['path'], input['filePath']]) {
    const value = nonempty(candidate);
    if (value !== null) names.add(value);
  }
  const listed = input['paths'];
  if (Array.isArray(listed)) {
    for (const candidate of listed) {
      const value = nonempty(candidate);
      if (value !== null) names.add(value);
    }
  }
  /**
   * A read's outcome comes from the result's structured tag, never a text
   * search: an `error` result (or the cancelled `question` envelope) is a
   * `miss`; a successful body that merely contains the word ENOENT stays a
   * `hit`. A hit read's coverage comes from the call's range arguments and the
   * host's truncation notice. Every other kind keeps `unknown` and no coverage:
   * this host exposes no match count or completeness flag for a search or a
   * listing.
   *
   * A hit read's `lineCount`/`byteLength` are the text the host sent — the same
   * bytes the unit body is (ISSUE-509). They were `null` while the body was a
   * one-line JSON envelope, so a measured line count would have been a lie about
   * the file. A miss measures nothing, and a search listing's output lines are
   * not a file's lines, so both keep `null`.
   */
  const readText = kind === 'read' ? toBytes(opencodeUnitText(result)) : null;
  const paths: PathEvidence[] = [...names].map(path => {
    const outcome: PathEvidence['outcome'] = kind === 'read'
      ? (opencodeIsErrorResult(result) ? 'miss' : 'hit')
      : 'unknown';
    const coverage = outcome === 'hit' ? readCoverageOf(input, result) : undefined;
    const measured = outcome === 'hit' && readText !== null
      ? { lineCount: splitLineOffsets(readText).length, byteLength: readText.byteLength }
      : { lineCount: null, byteLength: null };
    return {
      pathKey: path, displayPath: path, title: null,
      ...measured, outcome,
      ...(coverage === undefined ? {} : { coverage }),
    };
  });
  // The host's structured error tag is the failure fact (ISSUE-328, dsh
  // parity): it travels on the evidence whatever the kind, so a failed write
  // is never proof a path changed. Success declares nothing.
  return { kind, target: toolTarget(kind, input), paths, source: { ...source },
    sourceRecallId: null,
    ...(opencodeIsErrorResult(result) ? { failed: true } : {}) };
}

function displayPathOf(part: OpencodeContentPart): string | null {
  if (part.type === 'media') {
    const filename = nonempty(part['filename']);
    if (filename !== null) return filename;
    const media = part['media'];
    if (isRecord(media)) {
      const source = media['source'];
      if (isRecord(source)) return nonempty(source['url']);
    }
  }
  return null;
}

/**
 * Sorted-key JSON, so two spellings of the same object digest the same. Unlike
 * the core's canonical form this tolerates a host field the JSON type system
 * cannot express (`undefined`, a function): those are dropped exactly as
 * `JSON.stringify` would, instead of throwing on a part this build only files
 * as evidence.
 *
 * Only whole parts digest through this: it is the fallback evidence digest, not
 * a unit body. A unit's bytes are the result's own text (`opencodeUnitText`), so
 * no result value is ever key-sorted on its way into an archive.
 */
function canonicalText(value: unknown): string {
  return JSON.stringify(value, (_key: string, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = record[key];
    return sorted;
  }) ?? '';
}

/** One digest over the whole part, so a field this build ignores still moves evidence. */
function evidenceOf(part: OpencodeContentPart, partIndex: number): OpencodeAttachedEvidence {
  const bytes = toBytes(canonicalText(part));
  return {
    kind: 'part',
    partKey: isToolCall(part) || isToolResult(part) ? part.id : `p${String(partIndex)}`,
    partType: part.type,
    status: isToolCall(part) ? 'call' : null,
    displayPath: displayPathOf(part),
    hostCompaction: part.type === 'compaction',
    sha256: sha256Sync(bytes),
    byteLength: bytes.byteLength,
  };
}

function messageNode(
  id: NodeId, role: MessageNode['role'], toolCallIds: readonly string[],
  turnOrdinal: number, stepOrdinal: number, bytes: Uint8Array,
): MessageNode {
  return { kind: 'message', id, role, toolCallIds: [...toolCallIds],
    turnOrdinal, stepOrdinal, bytes, byteLength: bytes.byteLength, sha256: sha256Sync(bytes) };
}

function unitNode(
  id: NodeId, unit: OpencodeUnit, classify: OpencodeToolClassifier,
  turnOrdinal: number, stepOrdinal: number,
): ToolResultNode {
  const bytes = unitBytes(unit);
  const sha256 = sha256Sync(bytes);
  const input = isRecord(unit.call.part.input)
    ? unit.call.part.input as Readonly<Record<string, unknown>> : {};
  return { kind: 'tool-result', id, callId: unit.call.part.id,
    evidence: toolEvidence(unit.call.part.name, input, unit.result.part, classify,
      { nodeId: id, sha256, byteLength: bytes.byteLength }),
    embeddedRecords: [], turnOrdinal, stepOrdinal, bytes,
    byteLength: bytes.byteLength, sha256 };
}

function orphanResultNode(
  id: NodeId, part: OpencodeToolResultPart, classify: OpencodeToolClassifier,
  turnOrdinal: number, stepOrdinal: number,
): ToolResultNode {
  const bytes = orphanResultBytes(part);
  const sha256 = sha256Sync(bytes);
  return { kind: 'tool-result', id, callId: part.id,
    evidence: toolEvidence(part.name, {}, part, classify,
      { nodeId: id, sha256, byteLength: bytes.byteLength }),
    embeddedRecords: [], turnOrdinal, stepOrdinal, bytes,
    byteLength: bytes.byteLength, sha256 };
}

function recordNode(
  id: NodeId, recordId: string, turnOrdinal: number, stepOrdinal: number, bytes: Uint8Array,
): RacoonsRecordNode {
  return { kind: 'racoons-record', id, recordId, turnOrdinal, stepOrdinal, bytes,
    byteLength: bytes.byteLength, sha256: sha256Sync(bytes) };
}

/**
 * Attach each piece of evidence to the nearest node: the one before it, else the
 * one after it. Evidence with no node on either side is `unanchored`.
 */
function attach(emitted: readonly Emitted[]): {
  attached: Map<NodeId, OpencodeAttachedEvidence[]>;
  unanchored: OpencodeAttachedEvidence[];
} {
  const attached = new Map<NodeId, OpencodeAttachedEvidence[]>();
  const unanchored: OpencodeAttachedEvidence[] = [];
  let lastNodeId: NodeId | null = null;
  let pending: OpencodeAttachedEvidence[] = [];
  const flush = (owner: NodeId | null): void => {
    if (pending.length === 0) return;
    if (owner === null) unanchored.push(...pending);
    else {
      const group = attached.get(owner) ?? [];
      group.push(...pending);
      attached.set(owner, group);
    }
    pending = [];
  };
  for (const item of emitted) {
    if (item.kind === 'node') {
      flush(lastNodeId ?? item.node.id);
      lastNodeId = item.node.id;
    } else {
      pending.push(item.evidence);
    }
  }
  flush(lastNodeId);
  return { attached, unanchored };
}

export function deriveOpencodeSnapshot(
  messages: readonly OpencodeMessage[], options: OpencodeSnapshotOptions,
): OpencodeSnapshot {
  const sessionId = options.sessionId;
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new TypeError('snapshot derivation requires a non-empty session id');
  }
  const classify = options.classifier ?? createOpencodeToolClassifier();
  const { units } = buildUnits(messages);
  const emitted: Emitted[] = [];
  const nodeIds = new Set<string>();
  const consumedResults = new Set<string>();
  const addNode = (node: TranscriptNode): void => {
    if (nodeIds.has(node.id)) throw new Error(`duplicate snapshot node id ${node.id}`);
    nodeIds.add(node.id);
    emitted.push({ kind: 'node', node });
  };
  const addEvidence = (part: OpencodeContentPart, partIndex: number): void => {
    emitted.push({ kind: 'evidence', evidence: evidenceOf(part, partIndex) });
  };
  /**
   * The declaration facts a unit's node bytes do not hold. The body is the
   * result text (ISSUE-509), so a change to the tool name, the namespace, the
   * arguments, an absent-versus-null `input`, the result tag, or a content
   * entry the text drops would leave the revision still. The host rebuilds the
   * request from the store and the port refuses a stale revision, so such a
   * change must move the digest even though no node id, body byte or emitted
   * evidence part moved (audit F8, and the tag/non-text residue audit).
   */
  const callDigests = new Map<NodeId, string>();
  const resultKey = (site: OpencodeResultSite): string =>
    `${String(site.messageIndex)}:${String(site.partIndex)}`;

  let turn = 0;
  let step = 0;
  let prompts = 0;

  messages.forEach((message, messageIndex) => {
    const content = contentOf(message);
    const key = opencodeMessageKey(message, messageIndex);
    const recordId = recordIdOf(message);

    if (recordId !== null) {
      addNode(recordNode(opencodeMessageNodeId(sessionId, key), recordId,
        turn, step, toBytes(textOfContent(content))));
      return;
    }

    if (message.role === 'user' || message.role === 'system') {
      for (const part of content) {
        if (isToolCall(part) || isToolResult(part)) {
          throw new Error(`a ${message.role} message carries a tool part; `
            + 'only assistant and tool messages do');
        }
      }
      if (message.role === 'user') {
        if (prompts > 0) turn += 1;
        prompts += 1;
      }
      addNode(messageNode(opencodeMessageNodeId(sessionId, key), message.role,
        [], turn, step, toBytes(textOfContent(content))));
      content.forEach((part, partIndex) => {
        if (part.type !== 'text') addEvidence(part, partIndex);
      });
      return;
    }

    if (message.role === 'tool') {
      content.forEach((part, partIndex) => {
        if (isToolCall(part)) {
          throw new Error(`a tool message carries a tool-call part; `
            + 'only assistant messages do');
        }
        if (isToolResult(part)) {
          const unit = units.get(part.id);
          if (unit !== undefined) {
            if (!consumedResults.has(resultKey(unit.result))) {
              throw new Error(`tool result ${part.id} has no processed call`);
            }
            return;
          }
          addNode(orphanResultNode(opencodeToolNodeId(sessionId, part.id), part, classify,
            turn, step));
          callDigests.set(opencodeToolNodeId(sessionId, part.id), orphanCallDigest(part));
          consumedResults.add(`${String(messageIndex)}:${String(partIndex)}`);
          return;
        }
        addEvidence(part, partIndex);
      });
      return;
    }

    // One assistant message is one model step. A tool message never advances it.
    step += 1;
    const callIds: string[] = [];
    content.forEach((part) => {
      if (isToolCall(part) && units.has(part.id)) callIds.push(part.id);
    });
    const firstMessagePart = content.findIndex(isMessagePart);
    const firstUnitPart = content.findIndex(part => isToolCall(part) && units.has(part.id));
    const needsEntryNode = callIds.length > 0
      && (firstMessagePart === -1 || (firstUnitPart !== -1 && firstUnitPart < firstMessagePart));
    let declared = false;
    if (needsEntryNode) {
      addNode(messageNode(opencodeMessageNodeId(sessionId, key), 'assistant', callIds,
        turn, step, new Uint8Array(0)));
      declared = true;
    }
    content.forEach((part, partIndex) => {
      if (isMessagePart(part)) {
        addNode(messageNode(opencodePartNodeId(sessionId, key, partIndex), 'assistant',
          declared ? [] : callIds, turn, step, toBytes(part['text'] as string)));
        declared = true;
        return;
      }
      if (isToolCall(part)) {
        const unit = units.get(part.id);
        if (unit !== undefined) {
          addNode(unitNode(opencodeToolNodeId(sessionId, part.id), unit, classify,
            turn, step));
          callDigests.set(opencodeToolNodeId(sessionId, part.id), unitCallDigest(unit));
          consumedResults.add(resultKey(unit.result));
          return;
        }
        addEvidence(part, partIndex);
        return;
      }
      if (isToolResult(part)) {
        const unit = units.get(part.id);
        if (unit !== undefined) {
          // Its call was in this message earlier; the unit node already carries it.
          if (!consumedResults.has(resultKey(unit.result))) {
            throw new Error(`tool result ${part.id} precedes its call`);
          }
          return;
        }
        addNode(orphanResultNode(opencodeToolNodeId(sessionId, part.id), part, classify,
          turn, step));
        callDigests.set(opencodeToolNodeId(sessionId, part.id), orphanCallDigest(part));
        consumedResults.add(`${String(messageIndex)}:${String(partIndex)}`);
        return;
      }
      addEvidence(part, partIndex);
    });
  });

  const { attached, unanchored } = attach(emitted);
  const nodes = emitted.flatMap(item => item.kind === 'node' ? [item.node] : []);
  /**
   * The digest material, in two concatenated blocks: every node id, node hash
   * and emitted evidence digest — an evidence part attached to a node or left
   * unanchored — in emission order, then every unit's declaration digest in
   * emission order (declarations are appended after the emitted entries, never
   * interleaved). The declaration digest keeps a name/namespace/arguments/tag/
   * dropped-content change visible now that the node body is the result text
   * alone (ISSUE-509, audit F8): without it, changing the arguments or the tag
   * of a result whose text is unchanged would leave the revision still, and the
   * port's stale-revision refusal would accept a plan built for the older
   * request.
   */
  const digest = JSON.stringify([
    ...emitted.map(item => item.kind === 'node'
      ? ['node', item.node.id, item.node.sha256]
      : ['part', item.evidence.partKey, item.evidence.sha256]),
    ...[...callDigests].map(([id, digestOfCall]) => ['call', id, digestOfCall]),
  ]);
  const revision: Revision = `oc:${String(messages.length)}:${sha256Sync(toBytes(digest))}`;

  const currentTurnOrdinal = turn;
  /**
   * The projection never claims a turn complete on its own: `-1` before any
   * turn completes. A caller's turn-end fact (the mount records
   * `session.idle`'s turn) can raise that default, but never past the current
   * turn: a truncated or compacted rebuild can carry fewer turns than the fact
   * names, and core refuses a completed ordinal above the current one
   * (`invalid-plan`, transcript ordinal). `min(currentTurn, max(fact,
   * currentTurn - 1))` keeps the default and clamps a stale fact to the rebuilt
   * surface.
   */
  const suppliedCompleted = options.completedThroughTurnOrdinal;
  const completedThroughTurnOrdinal = typeof suppliedCompleted === 'number'
    && Number.isSafeInteger(suppliedCompleted)
    ? Math.min(turn, Math.max(suppliedCompleted, turn - 1))
    : turn - 1;
  const snapshot: SessionSnapshot = {
    sessionId,
    revision,
    currentTurnOrdinal,
    completedThroughTurnOrdinal,
    currentStepOrdinal: step,
    nodes,
    cache: options.cache ?? { kind: 'unknown' },
    retentionEvidence: options.retentionEvidence ?? [],
  };
  return { snapshot, attached, unanchored };
}

/**
 * The evidence shape a caller can build without importing the host: the
 * canonical digest of a part, plus the display facts this build reads. Exported
 * for tests and for a caller that wants to compare a host part with the journal.
 */
export function opencodePartEvidence(
  part: OpencodeContentPart, partIndex: number,
): OpencodeAttachedEvidence {
  return evidenceOf(part, partIndex);
}
