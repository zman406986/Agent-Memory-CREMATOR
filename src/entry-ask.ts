/**
 * The entry checkpoint's ask on the corrected protocol (ISSUE-058 chunk P3c-1;
 * ADR-0022 §3–§6, §14; anchor design §4 and §7).
 *
 * The result has ALREADY LANDED when this module runs, so the fork it grows is
 * the conversation exactly as it stands after that landing:
 *
 *   seedFork(main's wire after the landing)  system + tools + every turn so far
 *   + one `user` ask turn                    the contract, the line count, anchors
 *
 * The seed is chosen by what the caller can supply (ISSUE-058 chunk P3d). The
 * mount's LIVE-SURFACE projection wins when it is given: it is the only seed
 * that holds the assistant turn which made this result's tool call, because that
 * turn is a provider RESPONSE and no capture of a dispatched request carries it.
 * Without a surface the module uses main's captured request and appends the
 * landed result turn itself; that is correct until the session's second tool
 * call, where the capture already ends with the prior `tool` turn and the missed
 * assistant turn makes a second tool turn illegal. That case is refused as
 * `no-seed` with its own message: a call id and a tool name are not the bytes
 * main sent, and a fabricated turn in the prefix is worse than an ask not made.
 *
 * The ask never carries the body: `entryAskMessage` takes facts only (`N` and
 * the rendered anchors), so there is no parameter through which the body could
 * enter the question (ADR-0022 §3). `N` is the VISIBLE text's own line count
 * (ADR-0042 Decision 7): the capture's bytes are decoded, and a head cut that
 * splits a multi-byte character drops its incomplete tail bytes and decodes the
 * valid prefix. Nothing outside the capture is reconstructed: bytes that never
 * decode have no visible line, so their count is zero and they ship no anchors.
 * Positions are computed over those visible lines, never over a count the
 * capture cannot show.
 *
 * One correction turn, never a loop (ADR-0022 §6, anchor design §7). An answer
 * that cannot be applied arithmetically — an `invalid-span` parse refusal, a
 * `keeplines` range past `N`, or a `keeplines` that covers every line — earns
 * exactly one retry: the first answer is appended as an assistant turn and a
 * correction turn restates the SAME facts (the range sentence naming `N` and
 * the quotes, rendered from the same `EntryAskFacts` through the core's one
 * `entryAskFactsBlock`, never recomputed). The retry does not reopen
 * keep-or-forget. A second invalid answer lands the result whole. Every parse
 * refusal that is not arithmetic (malformed JSON, unknown action, a long note)
 * fails open at once, with no retry.
 *
 * Pure: no host state, no ledger, no engine, no journal. Every failure — no
 * seed, a refused fork append, a drifted prefix, a dead stream, a timeout,
 * empty text, an unreadable answer — is a typed `refused` value naming its
 * code; nothing here touches the guard or the breaker, and the landed result is
 * never modified (ADR-0022 §14: fail-open is the mount's apply-side duty).
 */
import {
  ENTRY_ASK_CLOSING_LINE, ENTRY_ASK_MIN_QUOTE_LINES, EntryAnswerError, ForkError, appendAsk,
  appendMessage, anchorsFor, entryAskFactsBlock, entryAskMessage, entryBatchAskMessage, fromBytes,
  parseEntryAnswer, parseEntryBatchAnswer, quoteCountOf, seedFork,
} from '@cremator/core';
import type {
  ApiUsage, Bytes, EntryAnswer, EntryAnswerErrorCode, EntryAskGrammar, EntryBatchRow,
  EntryBatchRowResult, WireFork, WireRequest,
} from '@cremator/core';
import { askWire } from './llm-ask.js';
import type {
  StreamAnswer, StreamAskOptions, StreamFailureReason, StreamOutcome,
} from './llm-ask.js';
import type { DshLlmService } from './plugin.js';

/**
 * The prompt variants a bench may select (ISSUE-061 T-8; ADR-0027 §4).
 * `default` is the shipped `keeplines` contract; `forgetlines` is lane F's. The
 * list is closed so a typo is a refusal by name, never a silent default.
 */
export const ENTRY_ASK_VARIANTS = ['default', 'forgetlines'] as const;

/** One entry-ask prompt variant; the contract the ask states. */
export type EntryAskVariant = (typeof ENTRY_ASK_VARIANTS)[number];

/**
 * The batch grammars this seam can compose (core's closed `EntryAskGrammar`).
 * The list is closed so a typo'd config name is refused as `unknown-grammar`
 * before core's grammar-gated renderer/parser can throw into the caller
 * (ISSUE-346), never a silent fallback to the shipped default.
 */
const ENTRY_ASK_GRAMMARS = ['3option', 'two-option', 'jsonl-20', 'jsonl-20-nokeepall'] as const;

/**
 * Why an entry ask produced no answer. The parser's own codes come first — an
 * unreadable answer names its defect exactly as the gate lane would — then the
 * ask-level causes, then the two arithmetic refusals under the planner's own
 * names (`spans-outside-result`, `keeps-every-line`), so a journal line and a
 * later `planEntryShape` refusal read the same word:
 *
 * - `no-seed` — main's sent request was never captured, or a fork could not be
 *   seeded or grown from it. No request leaves.
 * - `stream-error` — the stream threw, finished `error`/`aborted`, or was
 *   truncated by the token cap.
 * - `timeout` — the one deadline expired.
 * - `empty-text` — the reply carried no text at all (the parser's own code for
 *   an empty answer, reused rather than restated).
 * - `unknown-variant` — the caller named a prompt variant this seam does not
 *   have; no request leaves and no shipped default is silently assumed.
 * - `unknown-grammar` — the caller named a batch grammar this seam does not
 *   have (ISSUE-346); refused by name before anything is composed or sent, so
 *   core's grammar-gated renderer/parser can never throw into the caller.
 * - `no-quotes` — no row left in the batch can show the two quotes a tabled row
 *   shows (ADR-0042); no request leaves and every row lands untouched.
 */
export type EntryAskRefusalCode =
  | EntryAnswerErrorCode
  | 'no-seed' | 'stream-error' | 'timeout'
  | 'spans-outside-result' | 'keeps-every-line'
  | 'unknown-variant' | 'unknown-grammar' | 'no-quotes';

/**
 * The refusals the one correction turn answers (anchor design §7): an answer
 * that cannot be applied ARITHMETICALLY. Every other refusal fails open at
 * once, with no retry.
 */
export type EntryAskRetryCode = 'invalid-span' | 'spans-outside-result' | 'keeps-every-line';

/** The facts one ask states: the result's visible line count and its anchors. */
export interface EntryAskFacts {
  /** `N`, the visible decoded text's own line count (ADR-0042 Decision 7). */
  readonly lineCount: number;
  /** The rendered anchor lines; empty when the body has no visible line. */
  readonly anchorLines: readonly string[];
}

/** One turn of the ask exchange, in wire order and never re-rendered downstream. */
export interface EntryAskTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** One answered entry ask: the core's decoded answer, the raw text and the cost. */
export interface EntryAskAnswered {
  readonly status: 'answered';
  readonly answer: EntryAnswer;
  /** The reply text the answer was read from, verbatim — what the journal records. */
  readonly raw: string;
  /**
   * The exchange's observed cost, when the host reported `usage` chunks. With
   * the one correction turn this is BOTH sends summed; absent means the host
   * said nothing on either send, never a zero claim (ISSUE-056 C6a ruling).
   */
  readonly usage?: ApiUsage;
  /** True when the returned answer came from the one correction turn. */
  readonly retried: boolean;
  /**
   * The whole exchange as it stands on the fork, in order: the ask turn, and —
   * when retried — the first answer and the correction ask — last, the reply
   * the answer was read from (`raw`). The mount appends exactly these.
   */
  readonly turns: readonly EntryAskTurn[];
}

/**
 * One refused entry ask: a stable code, the raw text when there was one, data
 * only. `turns` is the exchange as far as the fork accepted it (empty before a
 * fork existed); a fail-open caller appends nothing, because the result is
 * already landed whole (ADR-0022 §14).
 */
export interface EntryAskRefused {
  readonly status: 'refused';
  readonly code: EntryAskRefusalCode;
  /** The last reply text the stream produced; absent when it produced none. */
  readonly raw?: string;
  /** The stream's own reason, when the refusal came from the stream seam. */
  readonly reason?: StreamFailureReason;
  /** A fixed, human-readable statement of the defect; never parsed by a caller. */
  readonly message: string;
  /** The exchange's observed cost, when the host reported one before the refusal. */
  readonly usage?: ApiUsage;
  /** True when the refusal came after the one correction turn was sent. */
  readonly retried: boolean;
  /** The turns the fork accepted before this refusal; empty when it took none. */
  readonly turns: readonly EntryAskTurn[];
}

/** The ask is not armed: no provider/model route, so no request leaves. */
export interface EntryAskOff {
  readonly status: 'off';
}

export type EntryAskOutcome = EntryAskAnswered | EntryAskRefused | EntryAskOff;

/** The route one ask goes to; `null` (or a blank pair) means the seam is off. */
export interface EntryAskRoute {
  readonly provider: string;
  readonly model: string;
}

export interface EntryAskOptions {
  /**
   * The landed result's bytes: the body the host already wrote, exactly as the
   * port holds it. `N` and the anchors are derived from these bytes, and the
   * fork's result turn carries their decoded text.
   */
  readonly resultBytes: Bytes;
  /**
   * Main's last captured request BEFORE the result landed (`mainWire.last(id)`
   * at the pre-step that follows the landing). The fork appends the landed
   * result turn to this capture itself; a capture that already ends with that
   * turn is recognised and not repeated, so either capture order is safe.
   *
   * This is a capture of a REQUEST, never of the host's surface. After a step
   * that carried tool calls, the next request's own last turn is the prior
   * `tool` result, so this capture is one assistant turn short of the state
   * main will actually send next: the assistant turn that made THIS result's
   * tool call is a response, and a request capture never holds it. Appending a
   * second `tool` turn to such a capture is the fork's `role-conflict`, which
   * this module reports as `no-seed` rather than inventing a turn.
   */
  readonly seed: WireRequest | null;
  /**
   * The mount's own view of main's wire as it stands AFTER this result landed —
   * the surface projection, not a request capture (ISSUE-058 chunk P3d; the
   * live blocker P3c-2 recorded). When supplied it IS the seed: every turn of
   * the conversation is already in it, including the assistant tool-call turn a
   * request capture cannot hold, so the fork appends the ask and nothing else.
   *
   * Absent (`null` or omitted) keeps the capture-only behaviour above. A mount
   * that can project its live surface should always pass one: it is the only
   * seed that stays correct past the first tool call of a session.
   */
  readonly surface?: WireRequest | null;
  /**
   * Which contract the ask states (ISSUE-061 T-8; ADR-0027 §4). Absent is the
   * shipped `keeplines` contract, byte for byte — the default path is unchanged,
   * so every mount that says nothing sends what it sent before. `'forgetlines'`
   * is lane F's one-partial-class variant, selected by a bench; a value outside
   * `ENTRY_ASK_VARIANTS` is refused as `unknown-variant` and nothing is sent.
   */
  readonly variant?: EntryAskVariant;
  readonly llm: DshLlmService;
  readonly route: EntryAskRoute | null;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

function refused(code: EntryAskRefusalCode, message: string,
  extra: Omit<EntryAskRefused, 'status' | 'code' | 'message'>): EntryAskRefused {
  return { status: 'refused', code, message, ...extra };
}

/**
 * The variant the caller asked for, or a refusal naming the value. `undefined`
 * is the shipped contract; anything else must be in the closed list, so a
 * typo'd bench knob fails loud instead of quietly running lane K.
 */
function variantOf(raw: string | undefined): EntryAskVariant | EntryAskRefused {
  if (raw === undefined) return 'default';
  if ((ENTRY_ASK_VARIANTS as readonly string[]).includes(raw)) return raw as EntryAskVariant;
  return refused('unknown-variant',
    `the entry ask has no prompt variant "${raw}"; use one of ${ENTRY_ASK_VARIANTS.join(', ')}`,
    { retried: false, turns: [] });
}

/**
 * The stream refusal's entry-lane code. The mapping is total and stated here so
 * a journal reader never sees a prune-lane reason in an entry line:
 *
 * - `no-text` becomes `empty-text`, the parser's own code for the same defect;
 * - `stream-truncated`, `aborted`, `not-configured` and `invalid-timeout` become
 *   `stream-error` (a configuration with no route is `off`, decided before
 *   sending; an invalid timeout is a config defect, ISSUE-344);
 * - `stream-error` and `timeout` keep their names.
 */
const STREAM_CODE: Readonly<Record<StreamFailureReason, EntryAskRefusalCode>> = Object.freeze({
  'not-configured': 'stream-error',
  'invalid-timeout': 'stream-error',
  'stream-error': 'stream-error',
  'stream-truncated': 'stream-error',
  timeout: 'timeout',
  aborted: 'stream-error',
  'no-text': 'empty-text',
});

/**
 * True when the route names a provider and a model; a blank pair is not armed.
 * The runtime type check keeps an unvalidated caller's malformed route from
 * throwing out of `askEntryBatch`: a non-string field reads as "not armed",
 * exactly as a blank pair does (ISSUE-427).
 */
function armed(route: EntryAskRoute | null): route is EntryAskRoute {
  return route !== null
    && typeof route.provider === 'string' && typeof route.model === 'string'
    && route.provider.trim() !== '' && route.model.trim() !== '';
}

/**
 * The landed body as one message's text. The host's item bytes are the UTF-8 of
 * the text it landed, so this round-trips exactly. A body that is not UTF-8 (a
 * rig can build one; a host cannot, because it encodes a string) is decoded
 * lossily for the PREFIX only — `N` and the anchors still come from the bytes.
 */
function landedTextOf(bytes: Bytes): string {
  try {
    return fromBytes(bytes);
  } catch {
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  }
}

/**
 * The text the capture visibly holds (ADR-0042 Decision 7). The host's item
 * bytes are the UTF-8 of the text it landed, so the whole buffer decodes and
 * this round-trips exactly. A capture cut inside a multi-byte character leaves
 * an incomplete tail sequence; those bytes are dropped and the valid prefix
 * decodes, because the bytes that are present are the context, and the partial
 * character is not a line to quote. Bytes that never decode elsewhere have no
 * visible line at all: the answer is the empty string, never a repaired or
 * guessed body.
 */
function visibleTextOf(bytes: Bytes): string {
  try {
    return fromBytes(bytes);
  } catch {
    // An incomplete UTF-8 sequence is at most three bytes, so a character cut
    // can only be healed by dropping one, two or three tail bytes.
    const longest = Math.min(3, bytes.byteLength);
    for (let dropped = 1; dropped <= longest; dropped += 1) {
      try {
        return fromBytes(bytes.subarray(0, bytes.byteLength - dropped));
      } catch {
        // Not this length; the cut is either longer or not at the tail.
      }
    }
    return '';
  }
}

/** The decoded body split on LF, with the terminator's empty slot dropped. */
function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/**
 * The ask's one variable part: the visible text's own line count and the
 * anchors off its visible lines (ADR-0042 Decision 7). Positions are computed
 * over exactly the lines the capture holds, so a truncated body quotes what it
 * shows and never a line outside it. A body with no visible line states zero
 * lines and ships no anchors; it is not tabled, because it cannot show the two
 * quotes a row must carry (Decision 5). Pure: the same bytes give the same
 * facts.
 */
export function entryAskFacts(resultBytes: Bytes): EntryAskFacts {
  const lines = linesOf(visibleTextOf(resultBytes));
  return { lineCount: lines.length, anchorLines: anchorsFor(lines) };
}

/**
 * Whether these facts carry the quotes a tabled row must show (ADR-0042
 * Decision 2): at least two rendered quote lines, and a blank-band notice is a
 * notice, not a quote. Membership is this reading and nothing else.
 */
export function factsShowTwoQuotes(facts: EntryAskFacts): boolean {
  return quoteCountOf(facts.anchorLines) >= ENTRY_ASK_MIN_QUOTE_LINES;
}

/**
 * Whether the landed bytes can be tabled at all (ADR-0042 Decision 5): the
 * mount reads this at admission and again on the live re-read at fire, so a
 * row that lost its quotes is dropped rather than shown as a bare row. A result
 * that fails it lands untouched: no ask and no removal at this seam.
 */
export function entryAskTableable(resultBytes: Bytes): boolean {
  return factsShowTwoQuotes(entryAskFacts(resultBytes));
}

/**
 * Main's wire state AFTER the result landed, from the capture alone: the capture
 * ends at the assistant turn that made the tool call, so appending the result is
 * exactly the turn the host then wrote — main's own bytes with the result in its
 * real place.
 *
 * There is NO dedupe here. A `WireMessage` carries no node/result id (core is
 * frozen), so a capture cannot tell THIS result's `tool` turn from a PRIOR
 * result whose bytes happen to be identical. Deduping by text equality
 * (ISSUE-348) misrecognized an identical prior result as already landed and
 * dropped the assistant+tool pair that actually landed, shortening the prefix
 * and losing the cache hit. `seedWire` instead refuses ANY capture that ends in
 * a `tool` turn (`no-seed`) before this is reached; only the mount's `surface`
 * seed — identity-cut at this result's own node — recognizes the landed turn and
 * is reused without doubling.
 *
 * Two limits, stated rather than papered over:
 *
 * - the fork's prefix is main's captured request, which `main-wire.ts` renders
 *   from text and tool-call blocks; it is not the provider's HTTP bytes and no
 *   code in this package sees those. "Byte-exact" in the tests means against the
 *   captured request — the whole wire state this seam is given.
 * - parallel tool calls land several results from ONE assistant turn, so the
 *   second ask's capture still ends at that assistant turn and cannot carry the
 *   first result. That ask's prefix is legal and its question is about the turn
 *   above it, but it is shorter than the host surface: a cache hit is lost for
 *   it, never correctness. A mount that can hand a fuller seed avoids that.
 */
function landedWire(seed: WireRequest, bodyText: string): WireFork {
  return appendMessage(seedFork(seed), { role: 'tool', text: bodyText });
}

/**
 * The facts block the first ask carried, rebuilt through the core's own
 * renderer so the two cannot drift: the range sentence naming `N`, then the
 * shortened quotes. `variant` is passed through because the range sentence
 * names the arm's partial class, so a lane F correction must say `forgetlines`
 * here too (ISSUE-106).
 */
function factsText(facts: EntryAskFacts, variant: EntryAskVariant = 'default'): string {
  return entryAskFactsBlock({ ...facts, variant });
}

/**
 * The ONE bounded correction turn (ADR-0022 §6; anchor design §7).
 *
 * It states the refusal code, says plainly that it does not put the keep-or-
 * forget question again, and restates the same facts block the first ask
 * carried (`factsText` over the caller's own `EntryAskFacts`, rendered by the
 * core, so the two cannot drift). It ends with the shipped closing line, so the
 * rig's end-anchor matcher still names this as an entry ask and serves it from
 * the entry lane. It never carries the body and never changes the grammar, the
 * option count or the floor.
 *
 * Its worked example is a REAL answer with the same bytes the prompt uses
 * (ISSUE-106): a substitution slot is not JSON, and the correction turn must
 * not teach a shape the parser refuses. `variant` names the arm's own partial
 * class, so a lane F correction teaches `forgetlines` and never leaks
 * `keeplines` into that arm (ADR-0027 §3–§4). It defaults to the shipped
 * contract, so every existing caller sends the bytes it sent before.
 */
export function entryRetryAskMessage(facts: EntryAskFacts, code: EntryAskRetryCode,
  variant: EntryAskVariant = 'default'): string {
  const partial = variant === 'forgetlines' ? 'forgetlines' : 'keeplines';
  const correction = `Your previous answer could not be applied: ${code}. This turn corrects `
    + 'an answer that could not be applied; it does not put the keep-or-forget question again.';
  const answer = 'Answer again, once, with exactly one JSON object: {"keepall":true}, '
    + '{"forgetall":"one-line summary of the whole result"}, or '
    + `{"${partial}":[[1,5],[9,12],"stale build log lines"]}. `
    + `A ${partial} answer always carries its summary: last in the array, or as a sibling `
    + '"summary" key, never both. '
    + `Ranges are 1-based and inclusive, inside [1,${String(facts.lineCount)}].`;
  return `${correction}\n${factsText(facts, variant)}\n${answer}\n${ENTRY_ASK_CLOSING_LINE}`;
}

/** Why a `keeplines` answer cannot be applied to the landed body, or null. */
function arithmeticRefusal(answer: EntryAnswer, total: number): EntryAskRetryCode | null {
  if (answer.action !== 'keeplines') return null;
  for (const range of answer.ranges) {
    if (range.to > total) return 'spans-outside-result';
  }
  const only = answer.ranges[0];
  if (answer.ranges.length === 1 && only !== undefined && only.from === 1 && only.to === total) {
    return 'keeps-every-line';
  }
  return null;
}

/** A fixed statement per arithmetic refusal, for the journal on a failed retry. */
function arithmeticMessage(code: EntryAskRetryCode, total: number): string {
  if (code === 'keeps-every-line') return 'the answer keeps every line, so it gives up nothing';
  if (code === 'spans-outside-result') {
    return `the answer names a line the landed result does not hold (${String(total)} lines)`;
  }
  return 'the answer names a span that is not an ascending integer range';
}

/**
 * Two sends' costs as one reading, when both exist. A field either the host did
 * not report stays unknown (`cachedInputTokens: null`), because a partial sum
 * would read as a cache share the provider never claimed.
 */
function sumUsage(first: ApiUsage | undefined, second: ApiUsage | undefined): ApiUsage | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cachedInputTokens: first.cachedInputTokens === null || second.cachedInputTokens === null
      ? null : first.cachedInputTokens + second.cachedInputTokens,
  };
}

/** The parser's reading of one reply text: an answer, or its own refusal. */
type EntryAckRead =
  | { readonly kind: 'answer'; readonly answer: EntryAnswer }
  | { readonly kind: 'refused'; readonly code: EntryAnswerErrorCode; readonly message: string };

function readAnswer(text: string): EntryAckRead {
  try {
    return { kind: 'answer', answer: parseEntryAnswer(text) };
  } catch (error) {
    if (error instanceof EntryAnswerError) {
      return { kind: 'refused', code: error.code, message: error.message };
    }
    // `parseEntryAnswer` refuses every readable input with its own error class,
    // so this arm covers a defect in the parser itself: it still fails open as
    // data, and the code says the answer could not be read.
    return { kind: 'refused', code: 'malformed-json', message: messageOf(error) };
  }
}

/**
 * One send over a fork, already marked as racoons' by the stream loop. The
 * fork's recorded hashes are re-asserted by `askWire`, so a drifted prefix
 * throws the fork's typed error instead of sending; that throw is `no-seed`
 * (a fork that cannot be used), never a stream claim.
 */
async function sendOnce(fork: WireFork, llm: DshLlmService, stream: StreamAskOptions,
  turns: readonly EntryAskTurn[], retried: boolean): Promise<StreamAnswer | EntryAskRefused> {
  let streamed: StreamOutcome;
  try {
    streamed = await askWire(llm, {
      system: fork.system,
      tools: fork.tools,
      messages: fork.messages,
      expected: { systemHash: fork.systemHash, toolsHash: fork.toolsHash },
    }, stream);
  } catch (error) {
    return refused('no-seed', messageOf(error), { retried, turns });
  }
  if (streamed.status === 'refused') {
    return refused(STREAM_CODE[streamed.reason], streamed.message,
      { retried, turns, reason: streamed.reason });
  }
  return streamed;
}

/**
 * The wire the fork is seeded from, chosen by which seed the caller could supply
 * (ISSUE-058 chunk P3d).
 *
 * The mount's live-surface projection wins whenever it is supplied: it already
 * holds every turn of the conversation as it stands after the landing, so the
 * fork appends the ask and nothing else. It is trusted only after one check —
 * its last turn must be THIS result's own `tool` turn, byte for byte — because a
 * surface that ends anywhere else would put the ask above the wrong content, and
 * the whole point of the ask is that it is about the turn immediately above it
 * (ADR-0022 §4).
 *
 * With no surface the capture is used, and the honest refusal is made explicit:
 * a capture whose last turn is a `tool` turn is the request that followed an
 * earlier result, so the assistant turn that made THIS result's tool call is a
 * response no request capture holds. A `WireMessage` has no node/result id, so
 * the capture cannot distinguish this result from a prior one even when their
 * bytes are identical (ISSUE-348) — ANY trailing `tool` turn is refused, never
 * deduped by text. Reconstructing the missing assistant turn from a call id and
 * a tool name would be a guess at bytes main will send, so this module refuses
 * instead — the result stays landed and whole, one journal line names `no-seed`,
 * and no fabricated turn ever reaches a prefix. The mount's `surface` seed is
 * identity-cut at this result's own node, so it alone recognizes the landed turn.
 */
function seedWire(options: Pick<EntryAskOptions, 'seed' | 'surface'>, bodyText: string): WireFork {
  const surface = options.surface ?? null;
  if (surface !== null) {
    const last = surface.messages[surface.messages.length - 1];
    if (last === undefined || last.role !== 'tool' || last.text !== bodyText) {
      throw new ForkError('invalid-message',
        'the mount surface does not end with this result\'s own landed turn; the ask would sit above the wrong content');
    }
    return seedFork(surface);
  }
  const seed = options.seed;
  if (seed === null) {
    throw new ForkError('invalid-message',
      'main\'s sent request was never captured; no fork can be seeded');
  }
  const last = seed.messages[seed.messages.length - 1];
  if (last !== undefined && last.role === 'tool') {
    // A capture carries no node/result id, so its last `tool` turn cannot be
    // proven to be THIS result rather than a PRIOR one — even when the bytes are
    // identical (ISSUE-348). Appending this result here would be two tool turns
    // in a row, and the assistant turn between them is a response no capture
    // holds. Refuse by name; the mount's identity-cut surface is what asks here.
    throw new ForkError('role-conflict',
      'main\'s last captured request ends with a prior tool result, so the assistant turn '
      + 'that made this result\'s tool call is not in it; a surface seed is needed to ask here');
  }
  return landedWire(seed, bodyText);
}

/**
 * Ask the agent once about one landed result, with at most one correction turn.
 *
 * One fork, one ask turn, one send; if the answer cannot be applied
 * arithmetically, one appended assistant turn and one correction turn, one more
 * send. Never more: the retry's answer is validated once and a second refusal
 * is returned as data. The caller decides what an answer or a refusal means;
 * this module never journals and never touches application state.
 */
export async function askEntry(options: EntryAskOptions): Promise<EntryAskOutcome> {
  if (!armed(options.route)) return { status: 'off' };
  const variant = variantOf(options.variant);
  if (typeof variant !== 'string') return variant;
  if ((options.surface ?? null) === null && options.seed === null) {
    return refused('no-seed',
      "main's sent request was never captured; no fork can be seeded",
      { retried: false, turns: [] });
  }
  const facts = entryAskFacts(options.resultBytes);
  const ask: EntryAskTurn = { role: 'user', text: entryAskMessage({ ...facts, variant }) };
  const bodyText = landedTextOf(options.resultBytes);
  let fork: WireFork;
  try {
    // The prefix is main's wire state after the landing — the mount's own
    // surface projection when it has one, the capture plus the landed result
    // turn otherwise — and never the pre-landing state.
    fork = appendAsk(seedWire(options, bodyText), ask.text);
  } catch (error) {
    return refused('no-seed', messageOf(error), { retried: false, turns: [] });
  }
  const stream: StreamAskOptions = {
    provider: options.route.provider,
    model: options.route.model,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const turns: readonly EntryAskTurn[] = [ask];
  const first = await sendOnce(fork, options.llm, stream, turns, false);
  if (first.status === 'refused') return first;
  const firstUsage = first.usage === undefined ? {} : { usage: first.usage };
  const read = readAnswer(first.text);
  const retryCode = read.kind === 'refused'
    ? (read.code === 'invalid-span' ? 'invalid-span' : null)
    : arithmeticRefusal(read.answer, facts.lineCount);
  if (retryCode === null) {
    if (read.kind === 'refused') {
      return refused(read.code, read.message,
        { raw: first.text, retried: false, turns, ...firstUsage });
    }
    return { status: 'answered', answer: read.answer, raw: first.text, retried: false,
      turns: [...turns, { role: 'assistant', text: first.text }], ...firstUsage };
  }
  const correction: EntryAskTurn = {
    role: 'user', text: entryRetryAskMessage(facts, retryCode, variant),
  };
  const firstAnswer: EntryAskTurn = { role: 'assistant', text: first.text };
  const retryTurns: readonly EntryAskTurn[] = [...turns, firstAnswer, correction];
  let grown: WireFork;
  try {
    grown = appendAsk(appendMessage(fork, firstAnswer), correction.text);
  } catch (error) {
    // The correction turn never reached a fork, so the exchange the mount
    // appends is the first ask alone: the answer text is kept for the journal,
    // and the landed result stays whole (ADR-0022 §14).
    return refused('no-seed', messageOf(error),
      { raw: first.text, retried: false, turns, ...firstUsage });
  }
  const second = await sendOnce(grown, options.llm, stream, retryTurns, true);
  if (second.status === 'refused') {
    // Both sends were paid for; a reading that names only the second would
    // under-report the exchange's cost.
    const merged = sumUsage(first.usage, second.usage);
    return merged === undefined ? second : { ...second, usage: merged };
  }
  const usage = sumUsage(first.usage, second.usage);
  const usageField = usage === undefined ? {} : { usage };
  const secondRead = readAnswer(second.text);
  if (secondRead.kind === 'refused') {
    return refused(secondRead.code, secondRead.message,
      { raw: second.text, retried: true, turns: retryTurns, ...usageField });
  }
  const again = arithmeticRefusal(secondRead.answer, facts.lineCount);
  if (again !== null) {
    return refused(again, arithmeticMessage(again, facts.lineCount),
      { raw: second.text, retried: true, turns: retryTurns, ...usageField });
  }
  return { status: 'answered', answer: secondRead.answer, raw: second.text, retried: true,
    turns: [...retryTurns, { role: 'assistant', text: second.text }], ...usageField };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── the batched ask (ISSUE-117 chunk B3; ADR-0035 §1–§6) ───────────────────

/** One row the mount hands the batched ask: the address and the landed bytes. */
export interface EntryBatchAskRow {
  /** 1-based; the answer's key and the row's position in the message. */
  readonly index: number;
  /** The call that made this result, as the host names it (`Read config.ts`). */
  readonly call: string;
  /** The landed result's bytes: `N` and the anchors are derived from them here. */
  readonly resultBytes: Bytes;
  /** The result's node id, so the mount can apply the row it answers. */
  readonly resultNodeId: string;
}

/**
 * One batch's answer: a result per assigned index, plus the exchange's raw text
 * and cost. A row that answered carries the entry answer its apply needs; a
 * refused row means KEEP, and the mount applies nothing for it.
 */
export interface EntryBatchAnswered {
  readonly status: 'answered';
  /** One result per row index, ascending — never fewer, never a neighbour's. */
  readonly rows: readonly EntryBatchRowResult[];
  /** The reply text the answers were read from, verbatim. */
  readonly raw: string;
  /** The first send's observed cost, when the host reported `usage` chunks. */
  readonly usage?: ApiUsage;
  /** True when this reading came from the one correction turn. */
  readonly retried: boolean;
  /** The exchange as it stands on the fork, in wire order. */
  readonly turns: readonly EntryAskTurn[];
}

/** A batch ask that produced no readable answer at all: data, naming its code. */
export interface EntryBatchRefused {
  readonly status: 'refused';
  readonly code: EntryAskRefusalCode;
  readonly raw?: string;
  readonly reason?: StreamFailureReason;
  readonly message: string;
  readonly usage?: ApiUsage;
  readonly retried: boolean;
  readonly turns: readonly EntryAskTurn[];
}

export type EntryBatchOutcome = EntryBatchAnswered | EntryBatchRefused | EntryAskOff;

/** The retry codes a batch answer can earn (same set as a single ask). */
function batchRetryCodes(rows: readonly EntryBatchRowResult[],
  lineCounts: ReadonlyMap<number, number>, grammar: EntryAskGrammar): ReadonlyMap<number, EntryAskRetryCode> {
  const codes = new Map<number, EntryAskRetryCode>();
  // `jsonl-20` has no arithmetic refusal: the reader already refuses an
  // out-of-bounds range (`spans-outside-result`) and an all-lines `keeplines` is
  // a legal keep-whole, so no row can earn the correction turn (ISSUE-183).
  if (grammar === 'jsonl-20') return codes;
  for (const row of rows) {
    if (row.status !== 'answered') continue;
    const total = lineCounts.get(row.index);
    if (total === undefined) continue;
    const code = arithmeticRefusal(row.answer, total);
    if (code !== null) codes.set(row.index, code);
  }
  return codes;
}

/**
 * The batch's ONE correction turn: the refused-by-arithmetic rows restated with
 * their own `N` and their own quotes, over the SAME indices, so no second
 * address scheme exists (the `prune-retry.ts` pattern, copied in shape only).
 * Rows that answered are not re-asked, and a batch with no arithmetic refusal
 * sends nothing here.
 *
 * Unreachable under `two-option` (ISSUE-129) and `jsonl-20` (ISSUE-183): a row
 * that names lines is refused as `action-not-in-grammar` before any range is
 * checked under `two-option`; under `jsonl-20` the line reader itself refuses an
 * out-of-bounds range and an all-lines `keeplines` is a legal keep-whole, so
 * `batchRetryCodes` is empty there too and this text — which teaches
 * `keeplines` — is never sent on either grammar.
 */
function batchCorrectionMessage(rows: readonly EntryBatchAskRow[],
  codes: ReadonlyMap<number, EntryAskRetryCode>): string {
  const reason = [...codes.entries()].map(([index, code]) => `${String(index)}: ${code}`).join(', ');
  const blocks = rows.filter(row => codes.has(row.index)).map(row => {
    const facts = entryAskFacts(row.resultBytes);
    return `Row ${String(row.index)}: ${factsText(facts)}`;
  }).join('\n\n');
  return `Your previous answer could not be applied for row(s) ${reason}. This turn corrects answers `
    + 'that could not be applied; it does not put the keep-or-forget question again.\n'
    + `${blocks}\nAnswer again, once, with exactly one JSON object keyed by the same indices, `
    + 'each row one of {"keepall":true}, {"forgetall":"one-line summary"}, or '
    + '{"keeplines":[[start,end],"one-line summary"]}. Ranges are 1-based and inclusive, inside each '
    + `row's own line count.\n${ENTRY_ASK_CLOSING_LINE}`;
}

/**
 * Ask the agent once about a BATCH of landed results (ISSUE-117 chunk B3;
 * ADR-0035 §1–§6).
 *
 * One fork, one ask turn carrying every row, one send; then, when a row's answer
 * cannot be applied arithmetically, one correction turn naming only those rows
 * and one more send. Never more. Under `3option` a one-row batch is `askEntry`'s
 * own bytes (`entryBatchAskMessage` delegates), so that grammar's path is
 * unchanged; under the shipped `jsonl-20` default a one-row batch is the table
 * shape, like every non-`3option` grammar.
 *
 * ISSUE-129 adds the grammar and passes it to both halves: the message
 * `entryBatchAskMessage` renders and each `parseEntryBatchAnswer` reading. Under
 * `two-option` the delegation above is off — that grammar's one-row message is
 * the table-row shape (`sim-batch-grammar.mjs:190-208`) — and no arithmetic
 * refusal is reachable, because a row that names lines is refused as
 * `action-not-in-grammar` before the ranges could be checked. The correction
 * turn therefore never fires on this grammar, and `batchCorrectionMessage`'s
 * `keeplines` option list is never sent.
 *
 * ISSUE-183 adds `jsonl-20` and passes the per-row line counts into both reads
 * (`parseEntryBatchAnswer`'s fourth argument): its `keeplines` bounds are
 * checked against the count the table showed. That reader refuses each bad range
 * itself and accepts an all-lines keep, so `batchRetryCodes` is empty under this
 * grammar too and no correction turn fires.
 *
 * ISSUE-194 adds `firstTrigger`. It selects the `jsonl-20` share line only —
 * 70 percent for the session's first ask, 40 percent for every later one, in
 * both halves of that message — and the mount owns the state that decides it.
 * The `3option` one-row delegation is the prose ask, which states no per-fire
 * share line, so its bytes are unchanged by the flag; it still counts as a
 * trigger for the mount, which is why the flag rides this seam rather than the
 * message builder alone.
 *
 * The fork is seeded from the LAST TABLED row's surface: that is the wire state
 * in which every tabled row of the batch has landed and the last one is the turn
 * the ask sits under, exactly as the single ask requires (ADR-0022 §4). A row
 * whose facts cannot show the two quotes a table row carries is not tabled
 * (ADR-0042 Decision 5); it keeps its own index, the remaining rows are
 * unchanged, and a batch with nothing left is `no-quotes`. Every row's answer
 * comes back keyed by its index, so the mount applies each as its own removal on
 * the entry seam; a refusal or a missing row keeps its unit.
 *
 * Pure of host state: no journal, no ledger, no engine. Every failure is a typed
 * `refused` value naming its code, and nothing throws into the caller.
 */
export async function askEntryBatch(options: {
  readonly rows: readonly EntryBatchAskRow[];
  readonly seed: WireRequest | null;
  readonly surface?: WireRequest | null;
  readonly llm: DshLlmService;
  readonly route: EntryAskRoute | null;
  /** The contract the ask states and reads; absent is the shipped `jsonl-20`. */
  readonly grammar?: EntryAskGrammar;
  /**
   * Whether this is the session's FIRST entry ask (ISSUE-194). The mount holds
   * the state — not this module and not a global — and passes `true` for the
   * session's first ask of either shape (a one-row batch or a multi-row one) and
   * `false` for every later ask. It selects the `jsonl-20` share line only: the
   * first trigger states the 70 percent keep target, a later trigger 40 percent,
   * in both halves of that one message. Absent is `true`, so a caller that says
   * nothing sends the first-trigger bytes; every other grammar ignores it.
   */
  readonly firstTrigger?: boolean;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}): Promise<EntryBatchOutcome> {
  if (!armed(options.route)) return { status: 'off' };
  const grammar = options.grammar ?? 'jsonl-20';
  // A grammar is config a JS caller can typo. Core's `entryBatchAskMessage` and
  // `parseEntryBatchAnswer` throw RangeError on an unknown name; this seam
  // promises nothing throws into the caller, so refuse by name before composing
  // or sending anything (ISSUE-346).
  if (!(ENTRY_ASK_GRAMMARS as readonly string[]).includes(grammar)) {
    return refused('unknown-grammar',
      `the entry batch ask has no grammar "${grammar}"; use one of ${ENTRY_ASK_GRAMMARS.join(', ')}`,
      { retried: false, turns: [] });
  }
  if (options.rows.length === 0) {
    return refused('no-seed', 'a batch ask needs at least one row', { retried: false, turns: [] });
  }
  // Every row's bytes become the ask's own facts: the anchors it quotes and the
  // `N` its one-row form states. Nothing here reads the body into the question.
  // A row whose facts cannot show two quotes is not tabled (ADR-0042 Decision
  // 5); it keeps its own index, so an answer can never move a neighbour's bytes.
  const measured = options.rows.map(row => ({ row, facts: entryAskFacts(row.resultBytes) }));
  const tabled = measured.filter(({ facts }) => factsShowTwoQuotes(facts));
  const only = tabled[0];
  if (tabled.length === 1 && only !== undefined && grammar === '3option') {
    // The default-off gate (ADR-0035 §3, §Consequences): a one-row batch IS
    // today's ask — the same message bytes, the same parse, the same one
    // correction turn — so it delegates rather than rederiving any of them.
    // A non-default grammar reaches the batch path below: its one-row message is
    // the table-row shape, not this prose ask.
    const single = await askEntry({
      resultBytes: only.row.resultBytes, seed: options.seed, surface: options.surface ?? null,
      llm: options.llm, route: options.route,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (single.status !== 'answered') return single;
    return { status: 'answered',
      rows: [{ index: only.row.index, status: 'answered', answer: single.answer }],
      raw: single.raw, retried: single.retried, turns: single.turns,
      ...(single.usage === undefined ? {} : { usage: single.usage }) };
  }
  if (tabled.length === 0) {
    return refused('no-quotes',
      'no row in this batch can show the two quotes a table row carries; nothing is asked',
      { retried: false, turns: [] });
  }
  if ((options.surface ?? null) === null && options.seed === null) {
    return refused('no-seed',
      "main's sent request was never captured; no fork can be seeded",
      { retried: false, turns: [] });
  }
  const ask: EntryAskTurn = {
    role: 'user',
    text: entryBatchAskMessage(tabled.map(({ row, facts: own }) => ({
      index: row.index, call: row.call, anchorLines: own.anchorLines, lineCount: own.lineCount,
    })), grammar, options.firstTrigger ?? true),
  };
  const last = tabled[tabled.length - 1];
  if (last === undefined) {
    return refused('no-quotes',
      'no row in this batch can show the two quotes a table row carries; nothing is asked',
      { retried: false, turns: [] });
  }
  const bodyText = landedTextOf(last.row.resultBytes);
  let fork: WireFork;
  try {
    fork = appendAsk(seedWire(options, bodyText), ask.text);
  } catch (error) {
    return refused('no-seed', messageOf(error), { retried: false, turns: [] });
  }
  const stream: StreamAskOptions = {
    provider: options.route.provider,
    model: options.route.model,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const indices = tabled.map(({ row }) => row.index);
  const lineCounts = new Map(tabled.map(({ row, facts }) => [row.index, facts.lineCount]));
  const turns: readonly EntryAskTurn[] = [ask];
  const first = await sendOnce(fork, options.llm, stream, turns, false);
  if (first.status === 'refused') return first;
  const firstUsage = first.usage === undefined ? {} : { usage: first.usage };
  const rows = parseEntryBatchAnswer(first.text, indices, grammar, lineCounts);
  const retryCodes = batchRetryCodes(rows, lineCounts, grammar);
  if (retryCodes.size === 0) {
    return { status: 'answered', rows, raw: first.text, retried: false,
      turns: [...turns, { role: 'assistant', text: first.text }], ...firstUsage };
  }
  const correction: EntryAskTurn = {
    role: 'user', text: batchCorrectionMessage(tabled.map(({ row }) => row), retryCodes),
  };
  const firstAnswer: EntryAskTurn = { role: 'assistant', text: first.text };
  const retryTurns: readonly EntryAskTurn[] = [...turns, firstAnswer, correction];
  let grown: WireFork;
  try {
    grown = appendAsk(appendMessage(fork, firstAnswer), correction.text);
  } catch (error) {
    // The correction never reached a fork: the first answer's reading stands,
    // with its arithmetic refusals meaning KEEP (ADR-0022 §14).
    return { status: 'answered', rows, raw: first.text, retried: false, turns,
      ...firstUsage };
  }
  const second = await sendOnce(grown, options.llm, stream, retryTurns, true);
  if (second.status === 'refused') {
    const merged = sumUsage(first.usage, second.usage);
    return merged === undefined ? second : { ...second, usage: merged };
  }
  const usage = sumUsage(first.usage, second.usage);
  const usageField = usage === undefined ? {} : { usage };
  const healed = new Map(parseEntryBatchAnswer(second.text, indices, grammar, lineCounts)
    .map(row => [row.index, row] as const));
  // Only the rows the correction re-asked can move: a row that already answered
  // keeps its first reading, and a row still refused keeps.
  const final = rows.map(row => retryCodes.has(row.index)
    ? healed.get(row.index) ?? row : row);
  return { status: 'answered', rows: final, raw: second.text, retried: true,
    turns: [...retryTurns, { role: 'assistant', text: second.text }], ...usageField };
}
