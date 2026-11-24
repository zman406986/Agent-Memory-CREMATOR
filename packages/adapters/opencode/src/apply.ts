/**
 * The wire-level span maths: one approved revert plan plus the host's own
 * request messages → the complete `Message[]` that plan leaves (ISSUE-192;
 * ADR-0044; plan §4).
 *
 * **Pure and deterministic.** The same (messages, plan) pair produces a
 * deep-equal array, and this module never writes to its input: it returns a new
 * array whose untouched messages are the very objects it was handed. No clock,
 * no ledger read, no host call. The port stages the result and `commit()` is the
 * one place that touches the caller's array.
 *
 * **The mapping.** A snapshot node is already a host element, and this module
 * re-projects the array onto the same node ids the projection emits,
 * cross-checking the result against `deriveOpencodeSnapshot` — the one owner of
 * the node list. A projection that disagrees refuses rather than guesses.
 *
 * **Four kinds of node**, because a removal's unit is a tool result while a
 * receipt's unit is a message:
 *   - `entry` — a user/system prompt, or a receipt message. It names the host
 *     message itself;
 *   - `declaration` — the adapter's entry-level `MessageNode` for an assistant
 *     message, emitted only so a tool result has a preceding call declaration
 *     (`packages/core/src/guard/checks-sources.ts`). It owns no host part, so it
 *     may vanish with the last call the plan removes;
 *   - `part` — one text or reasoning part;
 *   - `unit` — one tool-result unit: the `tool-call` part and the `tool-result`
 *     part, in one or two messages. A `forgetall` removal takes both, so no call
 *     is left dangling (ADR-0044 decision 3).
 *
 * **A partial `keeplines` keeps the unit.** The verdict's archive names only the
 * bytes it gives up (`opencodePartialKeeps`), so the derivation rewrites the
 * unit's typed result part to carry the kept lines and leaves the call part
 * standing. One text blob is written — a `text` value, or one `text` entry in a
 * `content` value — because the host drops empty entries and re-joins content
 * entries with a newline. The part keeps its `id`, `name` and `namespace`; only
 * the text changes. The archived body is the unit's decoded result text — the
 * exact bytes its line numbers count on; a legacy `{input,name,result}` envelope
 * is still read, with the kept bytes taken from its escaped result value. A
 * `json` or `error` result, or a `content` value carrying a file entry, refuses
 * `partial-keep-non-text` and keeps the unit whole (a content join is no single
 * fragment, so a legacy envelope carrying one refuses by the same name), and a
 * body whose text is not this result's refuses `partial-keep-unrepresentable`
 * rather than shipping a fragment.
 *
 * **The pair rule.** A plan that names an orphan result (a result whose call is
 * absent), a declaration/receipt node, or a unit whose call part is not in the
 * array refuses `tool-pair-split`. A call id carried by more than one call part
 * or more than one result part is also refused `tool-pair-split` here when this
 * derivation is reached directly; **on the mount path the snapshot projection
 * runs first and throws on that array**, so the hook journals `transform-error`
 * and no plan is derived (`snapshot.ts` `buildUnits`; `plugin.ts`
 * `transformStep`). A removal that would leave a pair ambiguous is never
 * applied either way.
 *
 * **Receipts land at message granularity** (plan §4: "inserted immediately after
 * its anchor entry"). A node maps to its message, so each receipt is inserted
 * directly after the message holding its anchor, grouped by that message and in
 * plan order. A receipt anchored inside an assistant message's tool-call group
 * lands after that group's last result message: a user message between a
 * `tool_calls` assistant message and its `tool` messages is not a shape the
 * provider accepts. An anchor whose message the removal drops still has a place:
 * the receipt lands where that message stood. An anchor of `null` lands before
 * everything.
 *
 * **A receipt's line is written once, keyed by the recall id.** The host
 * rebuilds every request from its own store, so the same removal is re-applied
 * on every request with a fresh intent id — and a fresh ledger record id, because
 * the record id hashes the event. The line names the earliest pass the
 * applied-plan index records for the removal's **recall id**, which does not
 * change with the event, so a re-application keeps the receipt's bytes and the
 * provider's prefix cache stops breaking at an early message. An array that
 * already carries a receipt line for that recall keeps every byte unchanged; the
 * line is found by its own shape — `[not retained] … · necromancy <recall id>`
 * — because some hosts keep the bytes and drop the `racoonsRecordId` marker.
 * **The message holding the line is reused or replaced in place, never copied
 * into a second line**: one recall id carries one receipt line across any number
 * of host rebuilds (ISSUE-262). The pass id is written only into a line that
 * carries none, so a label the first pass rendered is never lost to a later proof
 * pass that has none. The applied-plan row persists the rendered text per recall
 * id, so a plan whose array no longer carries the line still reuses the exact
 * bytes. A restore of the recall starts a new epoch only for a unit the array
 * places after the restore call: that first post-restore removal names its own
 * pass, and that pass stays named for every later re-application
 * (`stableReceiptPass`). A re-application of the removal the restore superseded
 * keeps the pass that first wrote it.
 *
 * **Refusals, every one decided before any write.** `plan-sha-mismatch`,
 * `intent-conflict`, `stale-revision`, `node-missing`, `tool-pair-split`,
 * `unknown-part-shape`, `system-head`, `reasoning-loss`,
 * `recall-answer-retained`, `contained-in-live-result`, `error-result-retained`,
 * `partial-keep-non-text`, `partial-keep-unrepresentable`,
 * `partial-keep-unusable`.
 *
 * The three retention rules — `recall-answer-retained`,
 * `contained-in-live-result` and `error-result-retained` — gate a **first-time
 * offer** only. The host rebuilds every request from its own store, so a unit a
 * prior pass removed is present again in the next array and the mount re-derives
 * its removal. That derivation is a re-application of a banked removal, not a
 * new offer: the unit's bytes are already archived under a recall and its
 * receipt was written, so the claim is that the removal stays in effect. The
 * applied-plan index names the units a prior pass forgot, and
 * `opencodeIsCommittedRemoval` reads it: a later live result that now contains
 * the unit's text does not reverse the removal. A visible `necromancy` restore
 * of that recall opens a new epoch (`restoreEpochOf`);
 * the unit it makes visible is a first-time offer again and the rules apply.
 * Each returns `status: 'refused'` with one of the core's three reasons and
 * leaves `messages` untouched. One class carries a `cleanup` array instead of
 * leaving the wire alone: an intent whose own receipt is in the array while its
 * forgotten node is readable again refuses `intent-conflict` and hands back the
 * array with those stale receipt lines dropped. The port stages that cleanup and
 * answers `not-applied`, so the false `[not retained]` line leaves the request
 * without any claim that the removal happened.
 */

import {
  complementByteRanges, revertBytes, sha256Sync, toBytes,
} from '@cremator/core';
import type {
  ApplyRequest, ArchiveRecord, ByteRange, NodeId, RecallId, RenderedRecord, ValidatedRevert,
} from '@cremator/core';
import { opencodeIsErrorResult } from './host.js';
import type {
  OpencodeMessage, OpencodeToolResultPart, OpencodeToolResultValue,
} from './host.js';
import {
  deriveOpencodeSnapshot, opencodeMessageKey, opencodeMessageNodeId, opencodePartNodeId,
  opencodeToolNodeId, OPENCODE_RECORD_ID_FIELD, OPENCODE_RECORD_PREFIX,
} from './snapshot.js';
import { OPENCODE_RECALL_TOOL_NAME } from './tools.js';

/** The marker field naming the ledger record a receipt renders (the plan's append). */
export const OPENCODE_RECEIPT_OF_FIELD = 'racoonsReceiptOf';

/** The marker field naming the node an entry replaced, so a re-run can prove it left. */
export const OPENCODE_FORGOTTEN_NODE_FIELD = 'racoonsForgottenNodeId';

/**
 * The command word an adapter receipt line carries before the pass that first
 * applied the removal it renders (ISSUE-256 item 1). The pass is an intent id a
 * reader can pair with a receipt group instead of trusting request order. The
 * segment lands before the ledger's own `· necromancy <recall id>` marker, so
 * every reader that finds the recall id at the end of the line keeps finding it.
 *
 * **The pass id is written once.** The host rebuilds every request from its own
 * store, so the same removal is re-applied on every request with a fresh intent
 * id and a fresh ledger record id (the record id hashes the event). Writing that
 * fresh id into the line would change the receipt's bytes at an early array
 * index on every request and break the provider's prefix cache. The pass a
 * receipt names is therefore the earliest pass the applied-plan index records
 * for the receipt's **recall id** — the one id the ledger keeps across events —
 * not for the per-application record id; see `stableReceiptPass`. A later pass
 * re-applies the same removal and leaves the line byte-identical.
 */
export const OPENCODE_RECEIPT_PASS_COMMAND = 'pass';

/**
 * The receipt line's trailing marker. The pass segment is inserted before it,
 * so every reader that finds the recall id at the end of the line still does.
 */
const RECEIPT_RECALL_MARKER = ' · necromancy ';

/** The first token of every receipt line core renders (`rules/assets.ts`). */
const RECEIPT_LINE_PREFIX = '[not retained] ';

/** The canonical recall-id spelling the ledger mints (`RecallId`). */
const RECALL_ID_PREFIX = 'recall:sha256:';

/** The two shorter spellings the `necromancy` tool accepts (tools.ts). */
const SHA256_ID_PREFIX = 'sha256:';
const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** The pass segment a receipt line carries: ` · pass <intent id>`. */
export function opencodeReceiptPassSegment(passId: string): string {
  return ` · ${OPENCODE_RECEIPT_PASS_COMMAND} ${passId}`;
}

/**
 * The recall id a ledger receipt line ends on, or `null` when the line has no
 * trailing `· necromancy <id>` marker. The marker the ledger renders is the
 * line's last segment, so a label that mentions the command word cannot be
 * mistaken for it.
 */
function recallIdOfReceiptLine(text: string): string | null {
  const at = text.lastIndexOf(RECEIPT_RECALL_MARKER);
  if (at < 0) return null;
  const recallId = text.slice(at + RECEIPT_RECALL_MARKER.length);
  return /^\S+$/u.test(recallId) ? recallId : null;
}

/**
 * The text a pass writes for one ledger receipt: the ledger's line with the
 * pass segment inserted before the trailing recall marker. `null` when the
 * text is not the product's receipt line (no trailing `· necromancy <id>`),
 * because a line with no marker has no place the pass contract defines.
 */
export function opencodeReceiptTextWithPass(text: string, passId: string): string | null {
  const recallId = recallIdOfReceiptLine(text);
  if (recallId === null) return null;
  const at = text.lastIndexOf(RECEIPT_RECALL_MARKER);
  return `${text.slice(0, at)}${opencodeReceiptPassSegment(passId)}${text.slice(at)}`;
}

/** Every `· pass` marker in a line, wherever it sits (the reader's own count). */
const RECEIPT_PASS_MARKERS = /·\s*pass(?=\s|$)/gu;
/** The writer's segment: the line's head ends on ` · pass <intent id>`. */
const RECEIPT_PASS_TRAILING = /(?:^|\s)·\s*pass\s+(\S+)\s*$/u;

/**
 * The pass a receipt line names, or why it names none. One reader for the two
 * places a line can come from: the observed array (whose host may have dropped
 * the marker fields) and the applied-plan row that persists the rendered text.
 *
 * The parse is positional, the same shape the bench's `receipt-line.mjs` reads:
 * the pass segment must be the head's trailing segment, immediately before the
 * `· necromancy <recall id>` marker. `absent` is the older writer — a line that
 * keeps its bytes and only needs the pass inserted. A `· pass` token anywhere
 * else is not the product's line and is reported `malformed`, never read as a
 * pass and never copied into a later request.
 */
type ReceiptPass =
  | { readonly status: 'named'; readonly passId: string }
  | { readonly status: 'absent' }
  | { readonly status: 'malformed' };

function receiptPassOfLine(text: string): ReceiptPass {
  const recallAt = text.lastIndexOf(RECEIPT_RECALL_MARKER);
  if (recallAt < 0) return { status: 'malformed' };
  const head = text.slice(0, recallAt);
  const markers = head.match(RECEIPT_PASS_MARKERS);
  if (markers === null) return { status: 'absent' };
  if (markers.length > 1) return { status: 'malformed' };
  const trailing = RECEIPT_PASS_TRAILING.exec(head);
  if (trailing === null || trailing[1] === undefined) return { status: 'malformed' };
  return { status: 'named', passId: trailing[1] };
}

/**
 * True when `text` is exactly one receipt line core renders:
 * `[not retained] <target><span><about> · necromancy <recall id>`, one line and
 * one recall marker. The whole text must be the line: a prompt or a tool result
 * that quotes a receipt keeps its own bytes and is not a receipt this
 * derivation may copy.
 */
function isReceiptLineText(text: string): boolean {
  if (!text.startsWith(RECEIPT_LINE_PREFIX)) return false;
  if (/[\r\n\u2028\u2029]/u.test(text)) return false;
  const at = text.indexOf(RECEIPT_RECALL_MARKER);
  if (at < 0 || at !== text.lastIndexOf(RECEIPT_RECALL_MARKER)) return false;
  return recallIdOfReceiptLine(text) !== null;
}

/**
 * The exact line a later pass ships for a receipt: an existing line names its
 * pass already, so it is returned byte for byte; a line without one gains the
 * stable pass in the one position the writer owns. `null` when the text is not
 * a receipt line this derivation can render.
 */
function pinnedReceiptText(text: string, passId: string): string | null {
  const parsed = receiptPassOfLine(text);
  if (parsed.status === 'named') return text;
  if (parsed.status === 'malformed') return null;
  return opencodeReceiptTextWithPass(text, passId);
}

/** The hex an id names, in any of the three spellings the recall tool accepts. */
function recallHexOf(id: string): string | null {
  if (SHA256_HEX.test(id)) return id;
  if (id.startsWith(RECALL_ID_PREFIX)) {
    const hex = id.slice(RECALL_ID_PREFIX.length);
    return SHA256_HEX.test(hex) ? hex : null;
  }
  if (id.startsWith(SHA256_ID_PREFIX)) {
    const hex = id.slice(SHA256_ID_PREFIX.length);
    return SHA256_HEX.test(hex) ? hex : null;
  }
  return null;
}

/**
 * The latest restore of each recall the request shows, keyed by the canonical
 * recall id and valued by the unit node id of the `necromancy` call that asked
 * for it. A restore call is the one visible fact that the pass which removed a
 * recall has been superseded: the host rebuilds its request from its own store,
 * so the old receipt never appears in a later array, and the request's restore
 * call is what dates the new epoch.
 *
 * Only a well-formed recall id counts; a call-id-shaped argument restores
 * nothing (ISSUE-256 item 2) and cannot mark an epoch.
 */
function restorationsIn(
  messages: readonly OpencodeMessage[], sessionId: string,
): ReadonlyMap<string, string> {
  const restored = new Map<string, string>();
  for (const message of messages) {
    for (const part of contentOf(message)) {
      if (!isToolCallPart(part) || part.name !== OPENCODE_RECALL_TOOL_NAME) continue;
      const input = part['input'];
      const stated = isRecord(input) ? input['id'] : undefined;
      if (typeof stated !== 'string') continue;
      const hex = recallHexOf(stated);
      if (hex === null) continue;
      // The last restore in transcript order is the current epoch.
      restored.set(`${RECALL_ID_PREFIX}${hex}`, opencodeToolNodeId(sessionId, part.id));
    }
  }
  return restored;
}

/**
 * The restore call a removal's recall shows and where the removed unit stands
 * relative to it, or `null` when the request shows no restore of that recall.
 *
 * `postRestore` is the epoch fact: the array places the unit *after* the
 * restore call, so the restore made this instance visible and every earlier
 * removal of the recall is superseded. A unit the array places *before* the
 * restore is the pre-restore instance the host rebuilt again; its removal is
 * being re-applied, not offered for the first time. Both `stableReceiptPass`
 * and `opencodeIsCommittedRemoval` read the same fact here so the receipt's
 * epoch and the retention decision cannot disagree.
 */
function restoreEpochOf(
  recallId: string, forgottenNodeId: string,
  restorations: ReadonlyMap<string, string>, nodeIds: readonly string[],
): { readonly restoreNodeId: string; readonly postRestore: boolean } | null {
  const restoreNodeId = restorations.get(recallId);
  if (restoreNodeId === undefined) return null;
  const restoreAt = nodeIds.indexOf(restoreNodeId);
  return {
    restoreNodeId,
    postRestore: restoreAt >= 0 && nodeIds.indexOf(forgottenNodeId) > restoreAt,
  };
}

/**
 * The pass a receipt for the recall `recallId` names (ISSUE-256 item 1): the
 * earliest pass the applied-plan index records for that recall, or this pass
 * when the index knows none.
 *
 * **The key is the recall id, not the ledger record id.** The ledger's record
 * id hashes the event, and the host rebuilds every request under a fresh event,
 * so the record id (`receipts[i]`) changes on every pass while the recall id
 * does not. Keying on the record id made the lookup miss on every
 * re-application and fall back to the current intent id, which is the churn the
 * pre-1e gate measured (`scratchpad/launch/2026-11-11-pre-1e-gate`). The index
 * is this process's read cache of the ledger's applied rows, in the order those
 * passes landed (`port.ts` `appliedPlanOf`), and `recalls` names the recall ids
 * each pass applied. The earliest match is the pass that first inserted the
 * receipt, so every later re-application of the same removal keeps the line's
 * bytes unchanged. A row written before `recalls` existed falls back to the note
 * id it does carry, which is the only key that row has.
 *
 * **A restore starts a new epoch only for a removal after it.** A visible
 * restore of R (`restoreNodeId` is that call's unit node) marks the removal it
 * superseded: a plan that removes a unit the array places *before* the restore
 * is re-applying that same pre-restore removal, so its line keeps the pass that
 * first wrote it. Only a unit the restore makes visible *after* the restore call
 * is a post-restore removal, and the first pass that removes it names its own
 * pass. That pass is the first indexed pass whose `forgotten` holds this unit —
 * a unit after the restore cannot have been removed before it — and every later
 * re-application in that epoch names that same pass. If no indexed pass removed
 * the unit yet, this pass is the first of the epoch.
 */
function stableReceiptPass(
  recallId: string, noteId: string, forgottenNodeId: string | null, passId: string,
  index: OpencodeAppliedPlanIndex, restoreNodeId: string | null,
  nodeIds: readonly string[],
): string {
  const restoreAt = restoreNodeId === null ? -1 : nodeIds.indexOf(restoreNodeId);
  const forgottenAt = forgottenNodeId === null ? -1 : nodeIds.indexOf(forgottenNodeId);
  const postRestore = restoreAt >= 0 && forgottenAt > restoreAt;
  let earliest: string | null = null;
  let afterRestore: string | null = null;
  for (const plan of index.values()) {
    if (!planAppliedRecall(plan, recallId, noteId)) continue;
    if (earliest === null) earliest = plan.intentId;
    if (postRestore && afterRestore === null && forgottenNodeId !== null
      && (plan.forgotten ?? []).includes(forgottenNodeId)) {
      afterRestore = plan.intentId;
    }
  }
  if (!postRestore) return earliest ?? passId;
  return afterRestore ?? passId;
}

/**
 * True when `plan` applied the removal this receipt renders. Rows the port
 * writes carry the recall ids; a legacy or hand-built row without `recalls`
 * falls back to the note id it recorded.
 */
function planAppliedRecall(
  plan: OpencodeAppliedPlan, recallId: string, noteId: string,
): boolean {
  if (plan.recalls !== undefined) return plan.recalls.includes(recallId);
  return plan.receipts.includes(noteId);
}

/** One receipt line the observed array already carries, with the message holding it. */
interface ExistingReceipt {
  readonly message: OpencodeMessage;
  readonly text: string;
}

/**
 * The receipt lines the observed array already carries, keyed by the recall id
 * each one names. **The line's own shape is the identity**, not the marker
 * field: the host keeps a receipt message's bytes when it rebuilds the request
 * but drops `racoonsRecordId` and the `racoons-record:` id, and a lookup that
 * required either one missed every earlier line (`scratchpad/launch/
 * 2026-11-11-diagnose-1e`). A line qualifies only when the whole message is the
 * product's receipt line, so a prompt or a tool result that quotes one is not
 * copied. The first line for a recall id in array order wins: it is the line
 * the first pass wrote.
 *
 * A line this intent wrote (recognisable while its record id survives) is
 * skipped: the idempotency check owns that case and must still refuse an entry
 * whose bytes this writer did not render (`intent-conflict`). Only a line
 * another pass left is reused.
 *
 * **The message is returned, not only its text.** A host rebuild keeps the
 * receipt line as a message of its own store; a pass that re-applies the same
 * removal must reuse that message rather than insert a second line for the same
 * recall id. The text alone made every re-application append a duplicate beside
 * the line it copied.
 */
function existingReceiptsByRecall(
  messages: readonly OpencodeMessage[], intentId: string,
): ReadonlyMap<string, ExistingReceipt> {
  const own = `${OPENCODE_RECORD_PREFIX}${intentId}:`;
  const found = new Map<string, ExistingReceipt>();
  for (const message of messages) {
    const recordId = recordIdOf(message);
    if (recordId !== null && recordId.startsWith(own)) continue;
    const recallId = receiptRecallIdOfMessage(message);
    if (recallId === null || found.has(recallId)) continue;
    found.set(recallId, { message, text: receiptTextOf(message) });
  }
  return found;
}

/**
 * The first rendered receipt line the applied-plan index records for a recall,
 * or `null` when the earliest applicable row carries none.
 *
 * **The first pass's line wins.** Rows land in pass order (`port.ts`
 * `appliedPlanOf`), so the first row that applied this recall decides; a later
 * row's text is never taken, because a later pass is exactly the one that used
 * to re-render the head. A first row from before this field existed has no
 * text, and the caller renders the ledger's own line instead.
 *
 * **A restore only opens an epoch for a unit after it.** For a post-restore
 * removal only a row that removed *this* unit counts, mirroring
 * `stableReceiptPass`: a pre-restore row removed a different instance of the
 * same recall, and its line must not be copied into the new epoch.
 */
function firstPersistedReceiptText(
  index: OpencodeAppliedPlanIndex, recallId: string, noteId: string,
  forgottenNodeId: string | null, postRestore: boolean,
): string | null {
  for (const plan of index.values()) {
    if (!planAppliedRecall(plan, recallId, noteId)) continue;
    if (postRestore && (forgottenNodeId === null
      || !(plan.forgotten ?? []).includes(forgottenNodeId))) continue;
    // The earliest matching row decides. A row from before this field existed
    // falls back to rendering the ledger's line; a later row's text is never
    // taken, because a later pass is the one that used to re-render the head.
    const text = plan.receiptTexts?.get(recallId);
    if (text === undefined || receiptPassOfLine(text).status === 'malformed') return null;
    return text;
  }
  return null;
}

/** One plan this process applied, keyed by intent id (plan §4's index). */
export interface OpencodeAppliedPlan {
  readonly intentId: string;
  readonly planSha256: string;
  readonly cutIndex: number;
  readonly survivors: readonly string[];
  /** The ledger record ids the plan's appends name, in plan order. */
  readonly receipts: readonly string[];
  /**
   * The canonical recall ids the plan's receipts name, in append order. The
   * record id changes with the event; the recall id is the stable key a later
   * re-application matches on. Optional so a row recorded before this field
   * existed still types: such a row has no recall information and is matched by
   * its note ids instead.
   */
  readonly recalls?: readonly string[];
  /**
   * The unit node ids the plan removed, in per-node order. The restore epoch
   * reads this to find the first pass that removed a unit the restore made
   * visible; `survivors` still dates whether a pass was derived with a restore
   * call in its array.
   */
  readonly forgotten?: readonly string[];
  /**
   * The `necromancy` restore call node ids the plan's own array showed. A row
   * written before a restore does not carry that restore's id, so a removal
   * offered after the restore is a new epoch and the retention rules apply
   * again. Optional so a hand-built or pre-field row still types; a missing
   * list is read as "saw no restore", the safe side for a first-time offer.
   */
  readonly restores?: readonly string[];
  /**
   * The exact receipt line this plan rendered, keyed by the recall id it names.
   * Additive: a row recorded before this field existed has none, and a later
   * pass then falls back to the ledger's own line. A plan whose observed array
   * no longer carries the receipt — a host rebuild that keeps neither the bytes
   * nor a marker — reuses this text verbatim, so the first pass's label and
   * pass id survive every re-application.
   */
  readonly receiptTexts?: ReadonlyMap<string, string>;
  /**
   * The units this plan removed PARTIALLY (a `keeplines` verdict or a ranged
   * `forget`), by node id (ISSUE-521 item 3). A banked removal is re-applied as
   * a whole-unit `forgetall` on the next rebuilt request; for a partial removal
   * that would over-remove the lines the request kept, so the re-apply must not
   * invent a whole-unit removal for a node this list names. A row written
   * before this field existed cannot tell, and the mount reads that absence as
   * "whole unit", the pre-521 behaviour.
   */
  readonly partial?: readonly string[];
}

/**
 * The applied-plan index: `intentId → what that intent applied`. A read cache of
 * the ledger's own rows. `rehydrateOnResume: false` means the port's map does not
 * survive a restart by itself: the mount reads the ledger's applied rows at
 * session open and seeds the port with them (`port.ts`
 * `opencodeAppliedPlansFromLedger`), so a banked removal is not offered as
 * first-time after a restart.
 */
export type OpencodeAppliedPlanIndex = ReadonlyMap<string, OpencodeAppliedPlan>;

/** The named refusal classes of plan §4. */
export type OpencodeDerivationCode =
  | 'plan-sha-mismatch'
  | 'stale-revision'
  | 'node-missing'
  | 'tool-pair-split'
  | 'unknown-part-shape'
  | 'system-head'
  | 'intent-conflict'
  | 'reasoning-loss'
  /**
   * The plan names a unit whose result is an error or a cancelled-tool envelope
   * (1f diagnosis FIX 2). The failure statement leaves the request, and a tool
   * called once has no other result that could control the removal — the 1f
   * `question` unit. Never a candidate, never applied.
   */
  | 'error-result-retained'
  /**
   * The plan names the `necromancy` tool's own answer (ISSUE-259). That result is
   * the product's restore payload; removing it makes the unit it restored look
   * never-sent and makes a later restore proof demand a restore for the result
   * that was itself the restore.
   */
  | 'recall-answer-retained'
  /**
   * The plan names a unit whose exact result text is a proper substring of
   * another live result's exact text (ISSUE-259). Every byte the removal takes
   * is still in the request, so the removal buys no context and makes the unit
   * look never-sent.
   */
  | 'contained-in-live-result'
  /**
   * A partial `keeplines` names a unit whose result is not text this host can
   * carry: a `json` or `error` tag, a `content` value with a file entry or with
   * no surviving text entry, or a legacy-envelope body carrying a content join
   * (no single fragment holds it). Its tag drives the miss/failed
   * classification, so the part is never rewritten; the unit keeps whole.
   */
  | 'partial-keep-non-text'
  /**
   * A partial `keeplines` names a unit whose archived body is not the result
   * part's own text. The kept byte ranges address the archive, so the kept lines
   * cannot be re-emitted inside the part without inventing bytes. The unit keeps
   * whole.
   */
  | 'partial-keep-unrepresentable'
  /**
   * A verdict archive a partial keep would read is unusable: its body differs
   * from its source, a removed range is out of bounds or differs from its hash,
   * one archive names the same node twice, two verdict archives name one node
   * (whole or partial), an archive names no source part, a receipt names a
   * different recall than its archive, an archive names a node this array does
   * not hold, or it names no dropped range at all (a whole keep is not a
   * removal). The plan is refused rather than repaired.
   */
  | 'partial-keep-unusable';

export interface OpencodeDerivedArray {
  readonly status: 'staged';
  readonly messages: readonly OpencodeMessage[];
  /**
   * The exact receipt text this derivation rendered, keyed by the recall id it
   * names, in append order. Additive: the port persists it in its applied-plan
   * row so a later pass whose array no longer carries the line — a resume, or a
   * host rebuild that drops the bytes — still ships the same receipt.
   */
  readonly receiptTexts?: ReadonlyMap<string, string>;
  /**
   * The restore call node ids this derivation's array showed, in transcript
   * order. The port persists them in its applied-plan row: they date the epoch
   * a removal belongs to, so a later pass can tell a removal applied in this
   * epoch from one a visible restore superseded. Additive.
   */
  readonly restores?: readonly string[];
}

export interface OpencodeDerivationRefusal {
  readonly status: 'refused';
  /** The core's `ApplyResult` vocabulary; the code carries the plan's own name. */
  readonly reason: 'stale-revision' | 'unsupported' | 'host-error';
  readonly code: OpencodeDerivationCode;
  readonly detail: string;
  /**
   * The array this refusal leaves behind when the wire needs fixing: the stale
   * receipts whose forgotten nodes are readable in the same request. The port
   * stages it for `commit()` and still answers `not-applied`, so the array stops
   * carrying a `[not retained]` line the model can contradict, and no applied
   * receipt or ledger record claims the removal.
   */
  readonly cleanup?: readonly OpencodeMessage[];
}

export type OpencodeDerivation = OpencodeDerivedArray | OpencodeDerivationRefusal;

/** Where one snapshot node came from in the host messages. */
interface NodeLocation {
  readonly nodeId: string;
  readonly entryIndex: number;
  readonly kind: 'entry' | 'declaration' | 'part' | 'unit';
  /** The host parts the node owns; empty for an entry-level node. */
  readonly parts: readonly { readonly entryIndex: number; readonly partIndex: number }[];
}

function refuse(
  reason: OpencodeDerivationRefusal['reason'], code: OpencodeDerivationCode, detail: string,
  cleanup?: readonly OpencodeMessage[],
): OpencodeDerivationRefusal {
  return cleanup === undefined
    ? { status: 'refused', reason, code, detail }
    : { status: 'refused', reason, code, detail, cleanup };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function contentOf(message: OpencodeMessage): readonly unknown[] {
  return Array.isArray(message.content) ? message.content : [];
}

function isToolCallPart(part: unknown): part is { readonly type: 'tool-call';
  readonly id: string; readonly name: string; readonly input?: unknown } {
  return isRecord(part) && part['type'] === 'tool-call'
    && typeof part['id'] === 'string' && part['id'].length > 0
    && typeof part['name'] === 'string';
}

function isToolResultPart(part: unknown): part is OpencodeToolResultPart {
  return isRecord(part) && part['type'] === 'tool-result'
    && typeof part['id'] === 'string' && part['id'].length > 0
    && typeof part['name'] === 'string'
    && isRecord(part['result'])
    && typeof (part['result'] as Record<string, unknown>)['type'] === 'string';
}

function isTextPart(part: unknown): part is { readonly type: 'text'; readonly text: string } {
  return isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string';
}

function isReasoningPart(part: unknown): part is { readonly type: 'reasoning';
  readonly text: string } {
  return isRecord(part) && part['type'] === 'reasoning' && typeof part['text'] === 'string';
}

function isMessagePart(part: unknown): boolean {
  return isTextPart(part) || isReasoningPart(part);
}

/** One reasoning part in transcript order, with the host object it is (ISSUE-256 item 4). */
interface ReasoningSite {
  readonly entryIndex: number;
  readonly partIndex: number;
  readonly text: string;
  readonly part: unknown;
}

function reasoningSites(messages: readonly OpencodeMessage[]): readonly ReasoningSite[] {
  const sites: ReasoningSite[] = [];
  messages.forEach((message, entryIndex) => {
    contentOf(message).forEach((part, partIndex) => {
      if (isReasoningPart(part)) sites.push({ entryIndex, partIndex, text: part.text, part });
    });
  });
  return sites;
}

/**
 * Why the derived array does not carry the kept reasoning parts exactly once,
 * in order, or `null` when it does. Identity is the comparison: at-rest rebuilds
 * a message by filtering the host's own content, so a reasoning part that
 * survives is the very object it was, and a duplicate is a second occurrence
 * of it. The expected list is every reasoning part the input carried: a plan
 * that names one is a loss, never an accepted removal.
 */
function reasoningMismatch(
  expected: readonly ReasoningSite[], derived: readonly ReasoningSite[],
): string | null {
  const common = Math.min(expected.length, derived.length);
  for (let index = 0; index < common; index += 1) {
    const before = expected[index];
    const after = derived[index];
    if (before === undefined || after === undefined) break;
    if (before.part !== after.part) {
      return `reasoning part ${String(index)} is not the input's part: `
        + `${JSON.stringify(before.text.slice(0, 40))} became `
        + `${JSON.stringify(after.text.slice(0, 40))}`;
    }
  }
  if (expected.length !== derived.length) {
    return `the derived array carries ${String(derived.length)} reasoning part(s) where the input `
      + `keeps ${String(expected.length)}`;
  }
  return null;
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

/** The id a receipt message carries for one intent's n-th append (plan §3). */
export function opencodeReceiptEntryId(intentId: string, index: number): string {
  return `${OPENCODE_RECORD_PREFIX}${intentId}:${String(index)}`;
}

interface CallSite { readonly entryIndex: number; readonly partIndex: number;
  readonly part: { readonly id: string; readonly name: string } }
interface ResultSite { readonly entryIndex: number; readonly partIndex: number;
  readonly part: OpencodeToolResultPart }

/** The call and result sites of one array, keyed by call id. */
function buildSites(messages: readonly OpencodeMessage[]): {
  calls: Map<string, CallSite[]>;
  results: Map<string, ResultSite[]>;
} {
  const calls = new Map<string, CallSite[]>();
  const results = new Map<string, ResultSite[]>();
  messages.forEach((message, entryIndex) => {
    contentOf(message).forEach((part, partIndex) => {
      if (isToolCallPart(part)) {
        const list = calls.get(part.id) ?? [];
        list.push({ entryIndex, partIndex, part });
        calls.set(part.id, list);
      }
      if (isToolResultPart(part)) {
        const list = results.get(part.id) ?? [];
        list.push({ entryIndex, partIndex, part });
        results.set(part.id, list);
      }
    });
  });
  return { calls, results };
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
 * The exact text one tool result carries (ISSUE-259). It is the host's own wire
 * lowering, byte for byte (the bench's `archivedResultWireText`):
 *
 *   - a `text` value is the string verbatim;
 *   - a `json` value is its JSON text, so the string `'abc'` lowers to `"abc"`,
 *     never to the bare bytes `abc`;
 *   - an `error` value is the string verbatim when it is a bare value, and its
 *     JSON text when it is an object or array (the host's own split);
 *   - a `content` array is its non-empty text entries joined with a newline, so
 *     a file entry contributes no text and an empty text entry is dropped
 *     before the join, as the host's normalizer drops it.
 *
 * The host's normalizer also rewrites an empty `text` or `error` value and a
 * `content` array with no surviving entry to `(no tool output)`, so this
 * lowering returns that same literal: the live request carries it, and a `''`
 * candidate could never be found inside it. The canonical
 * `{name,input,result}` envelope is deliberately not used for the containment
 * comparison: its JSON escaping would hide a verbatim occurrence of one result
 * text inside another.
 */
export function opencodeResultText(part: OpencodeToolResultPart): string {
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

/** One text payload a result part can carry, and the tag it is carried under. */
export interface OpencodeTextPayload {
  readonly text: string;
  readonly encoding: 'text' | 'content';
}

/**
 * The text a partial `keeplines` may re-emit inside this result part, or `null`
 * when the part cannot carry kept lines without corrupting what its tag means.
 *
 * The text is the host's own lowering (`opencodeResultText`): a `text` value
 * verbatim, or a `content` value's non-empty text entries joined with a newline
 * — the same text the unit's line numbers count on. Only two shapes qualify:
 *   - a `text` result whose value is a non-empty string;
 *   - a `content` result whose entries are text entries only, with at least one
 *     non-empty (a `file` entry would be silently lost by a rebuild, so the part
 *     refuses instead; an empty text entry is dropped by the host's normalizer
 *     before the wire, so dropping it changes no byte the model sees).
 *
 * A `json` or `error` result never qualifies: its tag is what makes the snapshot
 * read a miss or a failure, and rewriting it would change the transcript's
 * meaning, not only its size.
 */
export function opencodeTextPayload(part: OpencodeToolResultPart): OpencodeTextPayload | null {
  if (part.result.type === 'text') {
    const value = part.result.value;
    return typeof value === 'string' && value.length > 0
      ? { text: value, encoding: 'text' } : null;
  }
  if (part.result.type !== 'content' || !Array.isArray(part.result.value)) return null;
  const entries = part.result.value;
  if (entries.length === 0) return null;
  let survives = false;
  for (const entry of entries) {
    if (!isRecord(entry) || entry['type'] !== 'text' || typeof entry['text'] !== 'string') return null;
    if (entry['text'] !== '') survives = true;
  }
  return survives ? { text: opencodeResultText(part), encoding: 'content' } : null;
}

/**
 * The same result part with its text replaced and nothing else touched. The
 * part's `id`, `name`, `namespace` and every host field survive by spread; only
 * `result` is new. The payload's own `encoding` says which tag the part carries,
 * so a kept-lines result keeps it: ONE text blob either way, because the host
 * drops empty text entries before the wire and joins content entries with a
 * newline, so one entry per line would not survive a second normalizer pass.
 */
function withResultText(
  part: OpencodeToolResultPart, payload: OpencodeTextPayload,
): OpencodeToolResultPart {
  const result: OpencodeToolResultValue = payload.encoding === 'text'
    ? { type: 'text', value: payload.text }
    : { type: 'content', value: [{ type: 'text', text: payload.text }] };
  return { ...part, result };
}

/**
 * One archived partial keep: the unit's own body, the bytes its `keeplines`
 * verdict gives up, the kept bytes between them, and the recall that restores
 * the dropped lines.
 *
 * A verdict archive always holds the unit's whole body and the removal's byte
 * ranges inside it (`guard/recall.ts` `makeRecall`). A `forgetall` gives up the
 * whole span, so its complement is empty and it is not a partial keep. A
 * `keeplines` gives up the complement of the lines it keeps, so the complement
 * of the archived ranges is exactly the kept lines — re-derived here with core's
 * own complement, never read back from model output.
 *
 * This adapter mints every unit as its node's whole result
 * (`WholeResultSegmenter`), so a kept range inside an archived body can only
 * come from a `keeplines` answer.
 */
export interface OpencodePartialKeep {
  readonly nodeId: NodeId;
  /** The recall the unit's whole body restores under; the receipt names it. */
  readonly recallId: RecallId;
  /** The archived body: the byte space the unit's own line numbers counted. */
  readonly sourceBytes: Uint8Array;
  /** The bytes the removal gives up, in order. */
  readonly removedRanges: readonly ByteRange[];
  /** Every other byte: the kept lines, in order. */
  readonly keptRanges: readonly ByteRange[];
}

/** The partial keeps a validated application's archives carry, or why they cannot be read. */
export type OpencodePartialKeepSet =
  | {
      readonly status: 'derived';
      readonly keeps: ReadonlyMap<NodeId, OpencodePartialKeep>;
      /**
       * Every node a verdict archive in this application names, whole-unit or
       * partial. One archive per node: a second one for the same node is a plan
       * that archives one removal twice, whatever its ranges say.
       */
      readonly archived: ReadonlySet<NodeId>;
    }
  | {
      readonly status: 'invalid';
      readonly code: OpencodeDerivationCode;
      readonly detail: string;
    };

/**
 * Reads the partial keeps one validated application's verdict archives carry.
 *
 * Every entry is verified before it is trusted — the body against its source
 * hash and length, each removed range against its own hash and bounds, and the
 * ranges ordered and non-overlapping — because these bytes are about to be
 * copied into the model-visible request and the model never supplies them. The
 * adapter never repairs an archive: a malformed one is `partial-keep-unusable`
 * and the plan refuses. Whether the kept bytes are whole lines of the unit's
 * text is checked where the text is decoded (`partialKeepText`), because a
 * legacy envelope body's own line layout says nothing about the result's.
 *
 * A `forgetall`/whole-unit removal contributes no keep (its complement is
 * empty), but it is still recorded in `archived` so two archives naming one
 * node are refused. A verdict archive that names no source part, or a source
 * part naming no dropped range at all, is refused rather than read as a
 * "keep everything" removal: core normalizes a whole-range `keeplines` to
 * `keepall`, so a plan that still names one is malformed.
 */
export function opencodePartialKeeps(
  archives: readonly ArchiveRecord[],
): OpencodePartialKeepSet {
  const keeps = new Map<NodeId, OpencodePartialKeep>();
  const archived = new Set<NodeId>();
  for (const archive of archives) {
    if (archive.operationKind !== 'verdict') continue;
    if (archive.recall.parts.length === 0) {
      return { status: 'invalid', code: 'partial-keep-unusable',
        detail: `the verdict archive of removal ${archive.removalId} names no source part` };
    }
    const namedByThisArchive = new Set<NodeId>();
    for (const part of archive.recall.parts) {
      const nodeId = part.source.nodeId;
      if (namedByThisArchive.has(nodeId)) {
        return { status: 'invalid', code: 'partial-keep-unusable',
          detail: `one verdict archive names ${nodeId} more than once` };
      }
      namedByThisArchive.add(nodeId);
      if (archived.has(nodeId)) {
        return { status: 'invalid', code: 'partial-keep-unusable',
          detail: `two verdict archives name ${nodeId}` };
      }
      archived.add(nodeId);
      const bytes = new Uint8Array(part.bytes);
      if (bytes.length !== part.source.byteLength || sha256Sync(bytes) !== part.source.sha256) {
        return { status: 'invalid', code: 'partial-keep-unusable',
          detail: `the archived body of ${nodeId} differs from its source` };
      }
      const removedRanges: ByteRange[] = [];
      for (const span of part.removedRanges) {
        const { startByte, endByteExclusive } = span.range;
        if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByteExclusive)
          || startByte < 0 || endByteExclusive <= startByte || endByteExclusive > bytes.length) {
          return { status: 'invalid', code: 'partial-keep-unusable',
            detail: `an archived range of ${nodeId} is out of bounds` };
        }
        if (sha256Sync(bytes.slice(startByte, endByteExclusive)) !== span.sha256) {
          return { status: 'invalid', code: 'partial-keep-unusable',
            detail: `an archived removed range of ${nodeId} differs from its hash` };
        }
        removedRanges.push({ startByte, endByteExclusive });
      }
      if (removedRanges.length === 0) {
        return { status: 'invalid', code: 'partial-keep-unusable',
          detail: `the verdict archive of ${nodeId} names no dropped range; a whole keep is `
            + 'not a removal' };
      }
      let keptRanges: readonly ByteRange[];
      try {
        keptRanges = complementByteRanges(bytes.length, removedRanges);
      } catch {
        return { status: 'invalid', code: 'partial-keep-unusable',
          detail: `the archived ranges of ${nodeId} are unordered, overlapping or out of bounds` };
      }
      // A whole-unit removal keeps nothing: the by-reference removal path owns it.
      if (keptRanges.length === 0) continue;
      keeps.set(nodeId, {
        nodeId, recallId: archive.recall.id, sourceBytes: bytes, removedRanges, keptRanges,
      });
    }
  }
  return { status: 'derived', keeps, archived };
}

/** One byte range of an archived body, as an interval. */
interface ByteInterval {
  readonly start: number;
  readonly end: number;
}

/** One archived body decoded into text: the unit's own text and its byte region. */
interface ArchivedText {
  /** The text the unit's line numbers counted on (the host's own lowering). */
  readonly sourceText: string;
  /** The region of the body that holds that text, after any JSON unescaping. */
  readonly region: ByteInterval;
  /** How a body fragment inside the region becomes text. */
  readonly decode: (fragment: Uint8Array) => string;
}

/** What one partial keep's archive says its kept lines are, or why it cannot say. */
type PartialKeepText =
  | { readonly status: 'ok'; readonly text: string; readonly sourceText: string }
  | {
      readonly status: 'refused';
      readonly code: 'partial-keep-non-text' | 'partial-keep-unrepresentable';
      readonly detail: string;
    };

/** The first offset of `needle` in `haystack` at or after `from`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return -1;
  outer: for (let start = from; start + needle.length <= haystack.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}

/** True when `haystack` carries `needle` exactly at `at`. */
function matchesAt(haystack: Uint8Array, need: Uint8Array, at: number): boolean {
  if (at < 0 || at + need.length > haystack.length) return false;
  for (let offset = 0; offset < need.length; offset += 1) {
    if (haystack[at + offset] !== need[offset]) return false;
  }
  return true;
}

/** The legacy `{input,name,result}` envelope's `result`, when `body` is one. */
function envelopeResultOf(body: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  /**
   * Only a LEGACY archive body is an envelope: `snapshot.ts` `unitBytes` now
   * writes the decoded result text, and an envelope is a body stored before that
   * change. It carries exactly these three members, whatever their order.
   */
  if (!Object.hasOwn(parsed, 'input') || !Object.hasOwn(parsed, 'name')
    || !Object.hasOwn(parsed, 'result') || typeof parsed['name'] !== 'string') {
    return undefined;
  }
  return parsed['result'];
}

/** One fragment of the archived body as text, or `null` when it is not decodable. */
function fragmentText(fragment: Uint8Array, decode: ArchivedText['decode']): string | null {
  try {
    return decode(fragment);
  } catch {
    return null;
  }
}

/** The intersection of one range with the text region, or `null`; a straddle refuses. */
function regionPiece(range: ByteRange, region: ByteInterval): ByteInterval | null | 'straddle' {
  const start = Math.max(range.startByte, region.start);
  const end = Math.min(range.endByteExclusive, region.end);
  if (end <= start) {
    // Entirely outside the text region (envelope bytes) — or a zero-length cut.
    const outside = range.endByteExclusive <= region.start || range.startByte >= region.end;
    return outside ? null : 'straddle';
  }
  const straddles = range.startByte < region.start || range.endByteExclusive > region.end;
  return straddles ? 'straddle' : { start, end };
}

/**
 * The two text pieces a partial keep's archive splits its unit text into: what
 * stays and what leaves. Whole lines on both sides, in order, and together they
 * are exactly the unit's text — the check that makes the rewrite exact rather
 * than approximate.
 */
function wholeLinePartition(original: string, kept: string, dropped: string): boolean {
  const lines = original.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  let keptAt = 0;
  let droppedAt = 0;
  for (const line of lines) {
    if (kept.startsWith(line, keptAt)) { keptAt += line.length; continue; }
    if (dropped.startsWith(line, droppedAt)) { droppedAt += line.length; continue; }
    return false;
  }
  return keptAt === kept.length && droppedAt === dropped.length
    && (kept.length > 0 || dropped.length > 0);
}

/** How one archived body decodes: not an envelope, an envelope, or a named refusal. */
type ArchivedBody =
  | { readonly status: 'plain' }
  | { readonly status: 'text'; readonly archived: ArchivedText }
  | {
      readonly status: 'refused';
      readonly code: 'partial-keep-non-text' | 'partial-keep-unrepresentable';
      readonly detail: string;
    };

/**
 * The body of one partial keep decoded into the unit's own text.
 *
 * **The archived body is the unit's decoded result text**, so the kept byte
 * ranges slice it verbatim: the region is the whole body and each fragment is
 * copied as text. A body written before the snapshot fix is a legacy
 * `{input,name,result}` envelope; it is still read, with the kept bytes taken
 * from the escaped result value (unescaped strictly) and the envelope's own
 * fixed members outside it ignored. Either way the line accounting is the unit's
 * own text, never the envelope's length.
 */
function archivedTextOf(keep: OpencodePartialKeep): ArchivedBody {
  let body: string;
  try {
    body = strictDecoder.decode(keep.sourceBytes);
  } catch {
    return { status: 'refused', code: 'partial-keep-unrepresentable',
      detail: 'the archived body is not UTF-8 text' };
  }
  const result = envelopeResultOf(body);
  if (result === undefined) {
    // Not an envelope: the body is the unit's own text.
    return { status: 'plain' };
  }
  if (!isRecord(result) || result['type'] !== 'text' || typeof result['value'] !== 'string') {
    return { status: 'refused', code: 'partial-keep-non-text',
      detail: 'the archived envelope carries a result this host cannot re-emit as text' };
  }
  const quoted = toBytes(JSON.stringify(result['value']));
  const resultJson = toBytes(JSON.stringify(result));
  /**
   * The legacy envelope is `{"input":…,"name":…,"result":…}`, so the result is
   * the LAST member: its bytes sit immediately before the closing brace. That
   * anchor is what makes the lookup exact — an input key named `result` writes
   * its own `"result":` earlier in the body and must not be mistaken for the
   * envelope's member.
   */
  const resultKey = toBytes('"result":');
  const resultAt = keep.sourceBytes.length - 1 - resultJson.length;
  if (keep.sourceBytes[keep.sourceBytes.length - 1] !== 0x7d /* } */
    || !matchesAt(keep.sourceBytes, resultJson, resultAt)
    || !matchesAt(keep.sourceBytes, resultKey, resultAt - resultKey.length)) {
    return { status: 'refused', code: 'partial-keep-unrepresentable',
      detail: 'the archived envelope does not hold its result as its last member' };
  }
  // The result's own `"value":` key anchors the kept text: a text result object
  // carries exactly one, after `type`.
  const valueKey = toBytes('"value":');
  const valueAt = indexOfBytes(keep.sourceBytes, valueKey, resultAt);
  if (valueAt < 0
    || !matchesAt(keep.sourceBytes, quoted, valueAt + valueKey.length)) {
    return { status: 'refused', code: 'partial-keep-unrepresentable',
      detail: 'the archived envelope does not hold its result value as the bytes it names' };
  }
  return {
    status: 'text',
    archived: {
      sourceText: result['value'],
      region: { start: valueAt + valueKey.length + 1,
        end: valueAt + valueKey.length + quoted.length - 1 },
      decode: fragment => JSON.parse(`"${strictDecoder.decode(fragment)}"`) as string,
    },
  };
}

/**
 * The kept lines one partial keep's archive names, as text, or the named
 * refusal. Every piece is checked before it is copied into the request: the
 * kept and dropped fragments must each be whole lines of the unit's text, in
 * order, and together they must be that text exactly.
 */
function partialKeepText(keep: OpencodePartialKeep): PartialKeepText {
  const archived = archivedTextOf(keep);
  if (archived.status === 'refused') return archived;
  if (archived.status === 'text') return assemblePartialText(keep, archived.archived);
  let text: string;
  try {
    text = strictDecoder.decode(keep.sourceBytes);
  } catch {
    return { status: 'refused', code: 'partial-keep-unrepresentable',
      detail: 'the archived body is not UTF-8 text' };
  }
  return assemblePartialText(keep, {
    sourceText: text,
    region: { start: 0, end: keep.sourceBytes.length },
    decode: bytes => strictDecoder.decode(bytes),
  });
}

function assemblePartialText(keep: OpencodePartialKeep, archived: ArchivedText): PartialKeepText {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const range of keep.keptRanges) {
    const piece = regionPiece(range, archived.region);
    if (piece === 'straddle') {
      return { status: 'refused', code: 'partial-keep-unrepresentable',
        detail: 'a kept range straddles the archived text region' };
    }
    if (piece === null) continue;
    const text = fragmentText(keep.sourceBytes.slice(piece.start, piece.end), archived.decode);
    if (text === null) {
      return { status: 'refused', code: 'partial-keep-unrepresentable',
        detail: 'a kept fragment is not text this host can carry' };
    }
    kept.push(text);
  }
  for (const range of keep.removedRanges) {
    const piece = regionPiece(range, archived.region);
    if (piece === 'straddle') {
      return { status: 'refused', code: 'partial-keep-unrepresentable',
        detail: 'a dropped range straddles the archived text region' };
    }
    if (piece === null) continue;
    const text = fragmentText(keep.sourceBytes.slice(piece.start, piece.end), archived.decode);
    if (text === null) {
      return { status: 'refused', code: 'partial-keep-unrepresentable',
        detail: 'a dropped fragment is not text this host can carry' };
    }
    dropped.push(text);
  }
  const keptText = kept.join('');
  const droppedText = dropped.join('');
  if (keptText.length === 0) {
    return { status: 'refused', code: 'partial-keep-unrepresentable',
      detail: 'the kept ranges name no text of the unit' };
  }
  if (!wholeLinePartition(archived.sourceText, keptText, droppedText)) {
    return { status: 'refused', code: 'partial-keep-unrepresentable',
      detail: 'the kept and dropped fragments are not whole lines of the unit text' };
  }
  return { status: 'ok', text: keptText, sourceText: archived.sourceText };
}

/**
 * True when the array's unit already carries exactly this partial keep's kept
 * lines. A partial keep leaves the unit standing on purpose, so this is how the
 * identity run tells "the rewrite is in effect" from "the host rebuilt the full
 * result and the receipt now contradicts it".
 */
function carriesKeptLines(
  messages: readonly OpencodeMessage[], location: NodeLocation | undefined,
  keep: OpencodePartialKeep,
): boolean {
  const site = location?.kind === 'unit' && location.parts.length === 2
    ? location.parts[1] : undefined;
  if (site === undefined) return false;
  const part = messages[site.entryIndex]?.content[site.partIndex];
  if (!isToolResultPart(part)) return false;
  const payload = opencodeTextPayload(part);
  const kept = partialKeepText(keep);
  return payload !== null && kept.status === 'ok' && payload.text === kept.text;
}

/** One live tool result as the retention rules read it. */
export interface OpencodeLiveResult {
  readonly callId: string;
  readonly nodeId: NodeId;
  /** The host's own tool name; `necromancy` names the product's restore payload. */
  readonly toolName: string;
  /** The exact result text the request carries, never a hash. */
  readonly text: string;
  /**
   * True when the result is an error envelope: the host's `error` tag, or a
   * cancelled `question` (`{"error":…,"content":[]}`). Never eligible for
   * removal (1f diagnosis FIX 2).
   */
  readonly errorEnvelope: boolean;
}


/**
 * Every live tool result of one request array, in transcript order, one entry
 * per call id. This is the set a candidate's text is compared against: the
 * request's own bytes, before any plan writes to it.
 */
export function opencodeLiveResults(
  messages: readonly OpencodeMessage[], sessionId: string,
): readonly OpencodeLiveResult[] {
  const seen = new Set<string>();
  const live: OpencodeLiveResult[] = [];
  for (const message of messages) {
    for (const part of contentOf(message)) {
      if (!isToolResultPart(part) || seen.has(part.id)) continue;
      seen.add(part.id);
      live.push({ callId: part.id, nodeId: opencodeToolNodeId(sessionId, part.id),
        toolName: part.name, text: opencodeResultText(part),
        errorEnvelope: opencodeIsErrorResult(part) });
    }
  }
  return live;
}

/** The three retention rules a removal candidate must clear (ISSUE-259; 1f FIX 2). */
export type OpencodeRetentionCode =
  | 'recall-answer-retained' | 'contained-in-live-result' | 'error-result-retained';

/** One candidate the retention rules keep, with the fact that kept it. */
export interface OpencodeRetentionVerdict {
  readonly code: OpencodeRetentionCode;
  /** The live result whose exact text contains the candidate; null for a recall answer. */
  readonly containedInNodeId: NodeId | null;
}

/**
 * Why this node may not be removed, or `null` when it may.
 *
 *   - `error-result-retained` — the result is an error or a cancelled-tool
 *     envelope (`opencodeIsErrorResult`): a failure statement the model may need,
 *     with no second result of its tool to control the removal. Never eligible
 *     (1f diagnosis FIX 2);
 *   - `recall-answer-retained` — a result the `necromancy` tool produced is the
 *     product's own restore payload, so it is never eligible;
 *   - `contained-in-live-result` — the candidate's exact result text is a
 *     proper substring of another live result's exact text. Equality is not
 *     containment: a byte-identical duplicate is removable, and one plan may
 *     remove every copy. A live copy is not what makes that safe. Each forgotten
 *     node is banked under its own recall id and its receipt names that id, so
 *     every removed copy stays restorable byte-exact whether or not a duplicate
 *     survives (ADR-0037 decision 4). Identical bytes never share an id: the
 *     recall manifest names its source node, which differs per copy.
 *
 * A node that is not a live tool result is not this rule's subject and clears.
 *
 * **These rules answer a first-time offer only.** They are called on a removal
 * candidate, not on the history of the removal. A unit a prior pass already
 * banked is re-applied without them (`opencodeIsCommittedRemoval`): the bytes
 * are archived and the claim is that the removal stays in effect. A visible
 * restore of the recall starts a new epoch, and the unit it makes visible is a
 * first-time offer again.
 */
export function opencodeRetentionOf(
  nodeId: NodeId, live: readonly OpencodeLiveResult[],
): OpencodeRetentionVerdict | null {
  const self = live.find(result => result.nodeId === nodeId);
  if (self === undefined) return null;
  if (self.errorEnvelope) {
    return { code: 'error-result-retained', containedInNodeId: null };
  }
  if (self.toolName === OPENCODE_RECALL_TOOL_NAME) {
    return { code: 'recall-answer-retained', containedInNodeId: null };
  }
  if (self.text.length === 0) return null;
  const container = live.find(result => result.callId !== self.callId
    && result.text.length > self.text.length
    && result.text.includes(self.text));
  return container === undefined
    ? null
    : { code: 'contained-in-live-result', containedInNodeId: container.nodeId };
}

/**
 * True when a prior pass already applied this unit's removal — the unit is
 * **banked**, not offered for the first time.
 *
 * The applied-plan index is this process's read cache of the ledger's applied
 * rows (`port.ts` `appliedPlanOf`), and a row's `forgotten` names every unit
 * node that pass removed. A row naming this node id is a banked removal: the
 * unit's bytes were archived under a recall before the removal and a receipt
 * line was minted for it. A later request that rebuilds the array from the
 * host's store and re-derives the same removal is keeping that claim in effect,
 * so the three retention rules do not refuse it. The rules exist to stop a
 * *first* removal that buys no context; they must not reverse one whose bytes
 * are already banked.
 *
 * **A visible restore opens a new epoch.** When the request places the unit
 * after a `necromancy` call for its recall (`restoreEpochOf`), the restore made
 * this instance visible and every earlier removal of that recall is
 * superseded. Only a row whose own array already carried this restore call
 * (`plan.restores`) counts then; a row from before the restore, or a hand-built
 * row with no `restores`, does not. The safe side is the first-time read: the
 * rules apply and the unit is kept.
 */
export function opencodeIsCommittedRemoval(
  nodeId: NodeId, index: OpencodeAppliedPlanIndex,
  epoch: { readonly restoreNodeId: string; readonly postRestore: boolean } | null,
): boolean {
  const postRestore = epoch?.postRestore ?? false;
  for (const plan of index.values()) {
    if (!(plan.forgotten ?? []).includes(nodeId)) continue;
    if (!postRestore) return true;
    if ((plan.restores ?? []).includes(epoch?.restoreNodeId ?? '')) return true;
  }
  return false;
}

/**
 * The canonical recall id a restore argument names. The `necromancy` tool
 * accepts the raw hex digest, `sha256:<hex>` and `recall:sha256:<hex>`; the
 * applied-plan row always carries the canonical spelling.
 */
function recallIdOfRestoreArgument(value: string): string | null {
  const hex = /^[0-9a-f]{64}$/u.test(value)
    ? value
    : value.startsWith('sha256:')
      ? value.slice('sha256:'.length)
      : value.startsWith('recall:sha256:') ? value.slice('recall:sha256:'.length) : null;
  return hex !== null && /^[0-9a-f]{64}$/u.test(hex) ? `recall:sha256:${hex}` : null;
}

/**
 * The node id of the last `necromancy` call in this request that restores
 * `recallId`, or `null` when the request shows none. This is the fact
 * `restorationsIn` reads: a visible restore call is what dates a new epoch, and
 * the host drops only the receipt marker fields when it rebuilds its store,
 * never the call.
 */
function restoreNodeOfRecall(
  messages: readonly OpencodeMessage[], sessionId: string, recallId: string,
): string | null {
  const hex = recallId.startsWith('recall:sha256:')
    ? recallId.slice('recall:sha256:'.length) : null;
  if (hex === null || !/^[0-9a-f]{64}$/u.test(hex)) return null;
  let restoreNodeId: string | null = null;
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== 'tool-call' || part.name !== OPENCODE_RECALL_TOOL_NAME) continue;
      const stated = typeof part.input === 'object' && part.input !== null
        && !Array.isArray(part.input)
        ? (part.input as Record<string, unknown>)['id'] : undefined;
      if (typeof stated !== 'string') continue;
      if (recallIdOfRestoreArgument(stated) !== recallId) continue;
      const callId = part.id;
      if (typeof callId !== 'string') continue;
      restoreNodeId = opencodeToolNodeId(sessionId, callId);
    }
  }
  return restoreNodeId;
}

/**
 * The restore epoch a banked removal belongs to, in the shape
 * `opencodeIsCommittedRemoval` reads. The recall id is the applied-plan row's
 * own: `forgotten` and `recalls` are built in one loop over the plan's
 * forgotten nodes, so index `i` pairs them. The request's visible restore of
 * that recall and the unit's position relative to it are the same two facts
 * `deriveOpencodeRevert` computes (`restoreEpochOf`), so the pre-check and the
 * wire derivation cannot disagree about the epoch.
 *
 * `null` when no row recalls this unit, or the request shows no restore of it:
 * the rules then gate it as a first-time offer, the safe side.
 */
function committedRemovalEpochOf(
  nodeId: NodeId, appliedPlans: OpencodeAppliedPlanIndex,
  messages: readonly OpencodeMessage[], sessionId: string, nodeIds: readonly string[],
): { readonly restoreNodeId: string; readonly postRestore: boolean } | null {
  for (const plan of appliedPlans.values()) {
    const forgotten = plan.forgotten ?? [];
    const at = forgotten.indexOf(nodeId);
    if (at < 0) continue;
    // A row whose arrays disagree cannot pair the unit with a recall; reading
    // the wrong recall would date the wrong epoch, so it banks nothing here.
    const recalls = plan.recalls;
    if (recalls === undefined || recalls.length !== forgotten.length) continue;
    const recallId = recalls[at];
    if (typeof recallId !== 'string') continue;
    const restoreNodeId = restoreNodeOfRecall(messages, sessionId, recallId);
    if (restoreNodeId === null) return null;
    const restoreAt = nodeIds.indexOf(restoreNodeId);
    return {
      restoreNodeId,
      postRestore: restoreAt >= 0 && nodeIds.indexOf(nodeId) > restoreAt,
    };
  }
  return null;
}

/**
 * True when the observed array still carries a unit the ledger already banked
 * under a recall and the array does not place it after a visible restore of
 * that recall (ISSUE-300 item 6). This is the one test the apply path and the
 * ask builder share: a banked removal stays in effect on every rebuilt request
 * and must never be tabled as a new question after a restart.
 */
export function opencodeBankedRemovalOf(
  nodeId: NodeId, appliedPlans: OpencodeAppliedPlanIndex,
  messages: readonly OpencodeMessage[], sessionId: string, nodeIds: readonly string[],
): boolean {
  return opencodeIsCommittedRemoval(nodeId, appliedPlans,
    committedRemovalEpochOf(nodeId, appliedPlans, messages, sessionId, nodeIds));
}

/**
 * The array's nodes in projection order, each with the host element it came
 * from. Every branch mirrors `snapshot.ts`, because a node this function cannot
 * place is a refusal, never a guess.
 */
function projectEntries(
  messages: readonly OpencodeMessage[], sessionId: string,
): readonly NodeLocation[] {
  const { calls, results } = buildSites(messages);
  const units = new Map<string, { call: CallSite; result: ResultSite }>();
  for (const [id, list] of calls) {
    if (list.length > 1) throw new Error(`tool call ${id} is carried by ${String(list.length)} calls`);
    const call = list[0];
    const resultList = results.get(id);
    if (call === undefined || resultList === undefined || resultList.length === 0) continue;
    if (resultList.length > 1) {
      throw new Error(`tool call ${id} is carried by ${String(resultList.length)} results`);
    }
    const result = resultList[0];
    if (result === undefined) continue;
    if (result.entryIndex < call.entryIndex
      || (result.entryIndex === call.entryIndex && result.partIndex < call.partIndex)) {
      throw new Error(`tool result ${id} precedes its call`);
    }
    units.set(id, { call, result });
  }

  const locations: NodeLocation[] = [];
  const seen = new Set<string>();
  const consumed = new Set<string>();
  const push = (location: NodeLocation): void => {
    if (seen.has(location.nodeId)) throw new Error(`duplicate snapshot node id ${location.nodeId}`);
    seen.add(location.nodeId);
    locations.push(location);
  };
  const resultKey = (site: ResultSite): string =>
    `${String(site.entryIndex)}:${String(site.partIndex)}`;

  messages.forEach((message, entryIndex) => {
    const content = contentOf(message);
    const key = opencodeMessageKey(message, entryIndex);
    if (recordIdOf(message) !== null) {
      push({ nodeId: opencodeMessageNodeId(sessionId, key), entryIndex,
        kind: 'entry', parts: [] });
      return;
    }
    if (message.role === 'user' || message.role === 'system') {
      for (const part of content) {
        if (isToolCallPart(part) || isToolResultPart(part)) {
          throw new Error(`a ${message.role} message carries a tool part; `
            + 'only assistant and tool messages do');
        }
      }
      push({ nodeId: opencodeMessageNodeId(sessionId, key), entryIndex,
        kind: 'entry', parts: [] });
      return;
    }
    if (message.role === 'tool') {
      content.forEach((part, partIndex) => {
        if (isToolCallPart(part)) {
          throw new Error('a tool message carries a tool-call part; '
            + 'only assistant messages do');
        }
        if (!isToolResultPart(part)) return;
        const unit = units.get(part.id);
        if (unit !== undefined) {
          if (!consumed.has(resultKey(unit.result))) {
            throw new Error(`tool result ${part.id} has no processed call`);
          }
          return;
        }
        push({ nodeId: opencodeToolNodeId(sessionId, part.id), entryIndex, kind: 'unit',
          parts: [{ entryIndex, partIndex }] });
        consumed.add(`${String(entryIndex)}:${String(partIndex)}`);
      });
      return;
    }
    // An assistant message.
    const callIds = content.flatMap(part =>
      isToolCallPart(part) && units.has(part.id) ? [part.id] : []);
    const firstMessagePart = content.findIndex(isMessagePart);
    const firstUnitPart = content.findIndex(part => isToolCallPart(part) && units.has(part.id));
    if (callIds.length > 0
      && (firstMessagePart === -1 || (firstUnitPart !== -1 && firstUnitPart < firstMessagePart))) {
      push({ nodeId: opencodeMessageNodeId(sessionId, key), entryIndex,
        kind: 'declaration', parts: [] });
    }
    content.forEach((part, partIndex) => {
      if (isMessagePart(part)) {
        push({ nodeId: opencodePartNodeId(sessionId, key, partIndex), entryIndex,
          kind: 'part', parts: [{ entryIndex, partIndex }] });
        return;
      }
      if (isToolCallPart(part)) {
        const unit = units.get(part.id);
        if (unit === undefined) return;
        push({ nodeId: opencodeToolNodeId(sessionId, part.id), entryIndex, kind: 'unit',
          parts: [{ entryIndex: unit.call.entryIndex, partIndex: unit.call.partIndex },
            { entryIndex: unit.result.entryIndex, partIndex: unit.result.partIndex }] });
        consumed.add(resultKey(unit.result));
        return;
      }
      if (isToolResultPart(part)) {
        const unit = units.get(part.id);
        if (unit !== undefined) {
          if (!consumed.has(resultKey(unit.result))) {
            throw new Error(`tool result ${part.id} precedes its call`);
          }
          return;
        }
        push({ nodeId: opencodeToolNodeId(sessionId, part.id), entryIndex, kind: 'unit',
          parts: [{ entryIndex, partIndex }] });
        consumed.add(`${String(entryIndex)}:${String(partIndex)}`);
      }
    });
  });
  return locations;
}

/** The plain text a receipt message renders: its text parts joined. */
function receiptTextOf(message: OpencodeMessage): string {
  return contentOf(message)
    .filter((part): part is { readonly type: 'text'; readonly text: string } => isTextPart(part))
    .map(part => part.text)
    .join('');
}

/**
 * The recall id a message renders when the whole message is one receipt line,
 * or `null`. The line's own shape is the identity: the host drops the marker
 * fields when it rebuilds a request, so a run of receipts already sitting at
 * one anchor is found by the line itself.
 */
function receiptRecallIdOfMessage(message: OpencodeMessage): string | null {
  if (message.role !== 'user') return null;
  if (contentOf(message).some(part => !isTextPart(part))) return null;
  const text = receiptTextOf(message);
  if (!isReceiptLineText(text) || receiptPassOfLine(text).status === 'malformed') return null;
  return recallIdOfReceiptLine(text);
}

const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The receipt bytes as text, or `null` when they are not UTF-8 a text part can hold. */
function textOfRecord(record: RenderedRecord): string | null {
  try {
    return strictDecoder.decode(record.bytes);
  } catch {
    return null;
  }
}

/** The separator core's `receiptLine` writes before a descriptor. */
const RECEIPT_ABOUT_MARKER = ' — about: ';

/**
 * The write-side tool names whose receipt must name the target path (1g FIX 2).
 * A write result is a confirmation, never the file: its receipt is the only
 * place the model can read where the write landed once the result is gone.
 */
const WRITE_SIDE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write', 'edit', 'create', 'patch',
]);

/** The call-argument keys an opencode write-side tool names its target in. */
const WRITE_TARGET_INPUT_KEYS: readonly string[] = ['path', 'filePath', 'file_path'];

/** What a write-side unit's call named. */
interface WriteTarget {
  /** The path exactly as the call argument carried it, collapsed to one line. */
  readonly path: string;
}

/**
 * The target a write/edit/create/patch unit's call named, or `null` when the
 * unit is not write-side or names no path.
 *
 * The call part is read from the array this derivation is about to remove, so
 * the path is taken from the call's own arguments while they are still there.
 * A path argument is the fact; the result text is the host's phrasing and is
 * deliberately not parsed.
 */
function writeTargetOf(
  messages: readonly OpencodeMessage[], location: NodeLocation | undefined,
): WriteTarget | null {
  if (location === undefined || location.kind !== 'unit' || location.parts.length !== 2) {
    return null;
  }
  const site = location.parts[0];
  if (site === undefined) return null;
  const part = messages[site.entryIndex]?.content[site.partIndex];
  if (!isToolCallPart(part)) return null;
  const toolName = part.name.toLowerCase();
  if (!WRITE_SIDE_TOOL_NAMES.has(toolName)) return null;
  if (!isRecord(part.input)) return null;
  for (const key of WRITE_TARGET_INPUT_KEYS) {
    const value = part.input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { path: value.replace(/[\r\n\u2028\u2029]+/gu, ' ') };
    }
  }
  return null;
}

/** The last path segment of a tool path, in either separator. */
function pathBasename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at < 0 ? path : path.slice(at + 1);
}

/**
 * One path spelling with both separators and ASCII case folded (ISSUE-570).
 * Windows accepts either separator and either case, and the model's label may
 * spell the directory differently than the call did. The fold is one character
 * to one character — `toLowerCase` is not, `İ` alone becoming two — so every
 * index in the line stays valid and a match found in the fold slices the label.
 */
function sameSpacing(path: string): string {
  return path.replace(/\\/gu, '/').replace(/[A-Z]/gu, character => character.toLowerCase());
}

/**
 * The label text before a named directory, with the label's own directory
 * dropped (ISSUE-570). The call's path names the directory; joining the label's
 * spelling to it would name a directory twice, or name a path the file is not
 * under. A directory may contain spaces, so the whole run up to the separator
 * goes; text before a run that does not end in a separator is the label's own
 * voice and stays.
 */
function withoutDirPrefix(prefix: string): string {
  return /[\\/]$/u.test(prefix) ? '' : prefix;
}

/**
 * The line with the target path folded into its `— about:` descriptor (1g
 * FIX 2). Every byte outside that descriptor is the ledger's own: the target,
 * the ranges, the pass segment and the recall marker are untouched, so the
 * line keeps its shape and the readers that find its recall id still do.
 *
 * The descriptor is the model's own label, which named only the basename in
 * the 1g run; the directory is what it lacked. The path replaces the basename
 * when the label already names the file, and is appended in parentheses when
 * it does not. A line with no descriptor is a proof receipt and keeps its
 * floor shape (ADR-0018): there is no descriptor slot to fill.
 */
function writePathReceiptText(text: string, target: WriteTarget | null): string {
  if (target === null) return text;
  const recallAt = text.lastIndexOf(RECEIPT_RECALL_MARKER);
  if (recallAt < 0) return text;
  const head = text.slice(0, recallAt);
  const aboutAt = head.indexOf(RECEIPT_ABOUT_MARKER);
  if (aboutAt < 0) return text;
  const labelAt = aboutAt + RECEIPT_ABOUT_MARKER.length;
  const label = head.slice(labelAt);
  const spaced = sameSpacing(label);
  if (spaced.includes(sameSpacing(target.path))) return text;
  const base = pathBasename(target.path);
  const baseAt = base.length === 0 ? -1 : spaced.lastIndexOf(sameSpacing(base));
  const named = baseAt < 0
    ? `${label} (${target.path})`
    : `${withoutDirPrefix(label.slice(0, baseAt))}${target.path}${label.slice(baseAt + base.length)}`;
  return `${head.slice(0, labelAt)}${named}${text.slice(recallAt)}`;
}

/**
 * The canonical recall id a rendered receipt record names, or `null` when the
 * record is not the product's receipt line. The port records this id in the
 * applied-plan index: the ledger record id hashes the event and changes on
 * every pass, while the recall id is the removal's stable identity.
 */
export function opencodeReceiptRecallIdOfRecord(record: RenderedRecord): string | null {
  const text = textOfRecord(record);
  return text === null ? null : recallIdOfReceiptLine(text);
}

/** One receipt message: the marker, what it renders, and what it replaced (plan §3). */
function receiptEntry(
  intentId: string, index: number, noteId: string, text: string, forgottenNodeId: string,
): OpencodeMessage {
  const id = opencodeReceiptEntryId(intentId, index);
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    [OPENCODE_RECORD_ID_FIELD]: id,
    [OPENCODE_RECEIPT_OF_FIELD]: noteId,
    [OPENCODE_FORGOTTEN_NODE_FIELD]: forgottenNodeId,
  };
}

/** True when this message is a prompt: a user message that renders no ledger record. */
function isPromptEntry(message: OpencodeMessage): boolean {
  return message.role === 'user' && recordIdOf(message) === null;
}

/**
 * The array one approved revert leaves (plan §4). Pure: it reads `messages`,
 * never writes them, and the same inputs always produce a deep-equal array.
 */
export function deriveOpencodeRevert(
  request: ApplyRequest, messages: readonly OpencodeMessage[],
  index: OpencodeAppliedPlanIndex = new Map(),
  closedEpisodeNodes: ReadonlySet<NodeId> | null = null,
): OpencodeDerivation {
  const { application, intent } = request;
  const revert = application.revert;
  if (revert === undefined) {
    return refuse('host-error', 'plan-sha-mismatch', 'the application carries no revert plan');
  }
  // ADR-0004: the host applies exactly what the ledger prepared. The plan digest
  // is the one thing only the host can recompute, so a substituted cut, anchor
  // or cost refuses here instead of moving a different prefix.
  const { planSha256, ...approved } = revert;
  if (sha256Sync(revertBytes(approved)) !== planSha256) {
    return refuse('host-error', 'plan-sha-mismatch',
      'the revert plan does not hash to its approved digest');
  }
  // One intent, one plan. A second plan under an applied intent would append a
  // second receipt for work the first already claims (plan §4).
  const prior = index.get(intent.intentId);
  if (prior !== undefined && prior.planSha256 !== planSha256) {
    return refuse('host-error', 'intent-conflict',
      `intent ${intent.intentId} already applied a different plan`);
  }

  const sessionId = application.sessionId;
  // A call id on two call parts or two result parts is a pairing the array itself
  // no longer states. No plan over such an array is safe, so this runs before the
  // projection (which would throw on the duplicate node id).
  const { calls, results } = buildSites(messages);
  for (const [callId, list] of calls) {
    if (list.length > 1) {
      return refuse('unsupported', 'tool-pair-split',
        `tool call ${callId} is carried by ${String(list.length)} call parts`);
    }
  }
  for (const [callId, list] of results) {
    if (list.length > 1) {
      return refuse('unsupported', 'tool-pair-split',
        `tool call ${callId} is carried by ${String(list.length)} result parts`);
    }
  }
  let locations: readonly NodeLocation[];
  try {
    locations = projectEntries(messages, sessionId);
  } catch (error) {
    return refuse('unsupported', 'unknown-part-shape', messageOf(error));
  }
  const currentIds = locations.map(location => location.nodeId);
  const locationByNode = new Map(locations.map(location => [location.nodeId, location] as const));

  // A `keeplines` verdict's archive names only the bytes it gives up. Those are
  // the unit's dropped lines; their complement inside the archived body is the
  // kept lines, which the derivation re-emits inside the typed result part. A
  // malformed archive refuses the plan here, before any receipt is rendered.
  const partialKeeps = opencodePartialKeeps(application.archives);
  if (partialKeeps.status === 'invalid') {
    return refuse('unsupported', partialKeeps.code, partialKeeps.detail);
  }

  // The receipts the plan ships, verified before anything is built.
  const records = new Map(application.appendRecords.map(record => [record.recordId, record]));
  const restorations = restorationsIn(messages, sessionId);
  const existingReceipts = existingReceiptsByRecall(messages, intent.intentId);
  const receiptTexts: string[] = [];
  /** The array line each append may reuse, aligned with the plan's appends. */
  const arrayReceipts: (ExistingReceipt | undefined)[] = [];
  /** The exact line each recall id got, so the port can persist it. */
  const renderedByRecall = new Map<string, string>();
  /** The recall a forgotten unit is banked under, for the committed check. */
  const recallByForgotten = new Map<string, string>();
  for (const [n, append] of revert.appends.entries()) {
    const record = records.get(append.noteId);
    if (record === undefined || sha256Sync(record.bytes) !== record.sha256) {
      return refuse('host-error', 'plan-sha-mismatch',
        `receipt ${append.noteId} is not an intact part of this application`);
    }
    const text = textOfRecord(record);
    if (text === null) {
      return refuse('host-error', 'plan-sha-mismatch',
        `receipt ${append.noteId} is not UTF-8 text a message part can hold`);
    }
    const recallId = recallIdOfReceiptLine(text);
    if (recallId === null) {
      return refuse('host-error', 'plan-sha-mismatch',
        `receipt ${append.noteId} is not the product's receipt line, so it cannot name a pass`);
    }
    // The receipt names the pass that first applied this removal (ISSUE-256
    // item 1), keyed by the recall id: the ledger record id changes with the
    // event on every pass, the recall id does not. The exact line is pinned, not
    // only the pass: the observed array's own line is copied byte for byte
    // (found by its recall-id shape, since the host drops the marker field), and
    // when the array carries none, the first applied-plan row's persisted text
    // is. A line with no pass segment gains one; a line that names a pass —
    // including the label an earlier verdict pass rendered — keeps every byte.
    // Otherwise a later pass re-applying the same removal keeps the first pass
    // id instead of rewriting it with this request's fresh intent id. A visible
    // restore opens a new epoch only for a unit after the restore call: a line
    // written for the removal the restore superseded keeps its bytes, and the
    // first removal of a unit the restore made visible names its own pass and
    // stays named.
    const forgottenNodeId = revert.perNode[n]?.nodeId ?? null;
    const epoch = restoreEpochOf(recallId, forgottenNodeId ?? '', restorations, currentIds);
    const restoreNodeId = epoch?.restoreNodeId ?? null;
    const postRestore = epoch?.postRestore ?? false;
    if (forgottenNodeId !== null) recallByForgotten.set(forgottenNodeId, recallId);
    const passId = stableReceiptPass(recallId, append.noteId, forgottenNodeId,
      intent.intentId, index, restoreNodeId, currentIds);
    // A line the observed array already carries is reused as a message, not
    // copied into a second one: the host kept the line in its own store, so a
    // new receipt beside it would be a duplicate claim for the same recall.
    // A visible restore opens a new epoch, and a line for the removal it
    // superseded is not this epoch's line.
    const arrayReceipt = postRestore ? undefined : existingReceipts.get(recallId);
    arrayReceipts.push(arrayReceipt);
    const existing = arrayReceipt?.text
      ?? firstPersistedReceiptText(index, recallId, append.noteId, forgottenNodeId, postRestore)
      ?? undefined;
    // A write/edit/create receipt names the path its call wrote (1g FIX 2). The
    // ledger line is rendered from the model's label, which may name only the
    // basename; the call's own argument carries the directory. Only a line this
    // pass renders gains the path: an earlier pass's line is pinned byte for
    // byte, so a re-application never rewrites it.
    const target = existing === undefined
      ? writeTargetOf(messages, locationByNode.get(forgottenNodeId ?? ''))
      : null;
    const withPass = existing === undefined
      ? opencodeReceiptTextWithPass(writePathReceiptText(text, target), passId)
      : pinnedReceiptText(existing, passId);
    if (withPass === null) {
      return refuse('host-error', 'plan-sha-mismatch',
        `receipt ${append.noteId} is not the product's receipt line, so it cannot name a pass`);
    }
    receiptTexts.push(withPass);
    if (!renderedByRecall.has(recallId)) renderedByRecall.set(recallId, withPass);
  }

  // Idempotency, keyed by intent id (plan §4): this derivation's own output
  // carries one marker per append. Every receipt present and every replaced host
  // node already gone is the identity run — the array is its own result, so it is
  // returned as it stands and nothing is appended twice.
  //
  // **Identity first.** This block runs before the revision match and before the
  // archive-node check below, so a replay of this intent over its own output
  // stages even when one of its archives names a node the array no longer holds.
  // The array is already the plan's result and nothing is applied to return it;
  // archive bytes may still be read for the identity check itself (a partial
  // replay decodes the archived body to see whether the kept lines are in
  // effect). The later checks guard a fresh application, not a replay.
  {
    const expected = revert.appends.map((_append, n) => opencodeReceiptEntryId(intent.intentId, n));
    const present = expected.filter(id =>
      messages.some(message => recordIdOf(message) === id)).length;
    const stranger = messages.find((message) => {
      const recordId = recordIdOf(message);
      if (recordId === null) return false;
      const prefix = `${OPENCODE_RECORD_PREFIX}${intent.intentId}:`;
      return recordId.startsWith(prefix) && !expected.includes(recordId);
    });
    if (stranger !== undefined) {
      return refuse('host-error', 'intent-conflict',
        `the array carries receipt ${String(recordIdOf(stranger))}, which this plan never rendered`);
    }
    if (present > 0) {
      if (present !== expected.length) {
        return refuse('host-error', 'intent-conflict',
          `${String(present)} of ${String(expected.length)} receipts of this intent are present`);
      }
      const forgottenIds: string[] = [];
      for (const [n, id] of expected.entries()) {
        const found = messages.filter(message => recordIdOf(message) === id);
        const append = revert.appends[n];
        const entry = found[0];
        if (found.length > 1) {
          return refuse('host-error', 'intent-conflict', `receipt ${id} appears more than once`);
        }
        if (entry === undefined || append === undefined) {
          return refuse('host-error', 'intent-conflict', `receipt ${id} is missing`);
        }
        const forgottenId = entry[OPENCODE_FORGOTTEN_NODE_FIELD];
        if (entry[OPENCODE_RECEIPT_OF_FIELD] !== append.noteId
          || receiptTextOf(entry) !== receiptTexts[n]
          || typeof forgottenId !== 'string' || forgottenId.length === 0) {
          return refuse('host-error', 'intent-conflict',
            `receipt ${id} in the array is not the one this plan rendered`);
        }
        forgottenIds.push(forgottenId);
      }
      /**
       * True when this forgotten node's removal no longer holds in the array:
       * the node is readable again, and either it is a whole-unit removal (so
       * its bytes being back contradicts the receipt) or a partial keep whose
       * result no longer carries the kept lines. A partial keep's unit is
       * SUPPOSED to stay: only a rebuilt full result contradicts its receipt.
       */
      const contradicted = (forgottenId: string): boolean => {
        if (!currentIds.includes(forgottenId)) return false;
        const partial = partialKeeps.keeps.get(forgottenId);
        if (partial === undefined) return true;
        return !carriesKeptLines(messages, locationByNode.get(forgottenId), partial);
      };
      const stillThere = forgottenIds.filter(contradicted);
      if (stillThere.length > 0) {
        // The array carries this intent's receipts while the content they say
        // was not retained is readable in the same request. The receipt line is
        // a false statement the model can contradict, so it leaves the wire:
        // every receipt whose forgotten node is back is dropped, and the rest of
        // the array keeps every byte. The port stages this cleanup and answers
        // `not-applied`, so nothing claims the removal succeeded.
        //
        // **A partial keep's valid receipt is never dropped.** Its unit stays by
        // design, so the same predicate decides both lists: a mixed plan (one
        // rebuilt whole-unit removal beside a partial keep) drops only the
        // receipt whose content actually came back.
        const stale = new Set<string>();
        expected.forEach((id, n) => {
          const forgotten = forgottenIds[n];
          if (forgotten !== undefined && contradicted(forgotten)) stale.add(id);
        });
        const cleaned = messages.filter((message) => {
          const recordId = recordIdOf(message);
          return recordId === null || !stale.has(recordId);
        });
        return refuse('host-error', 'intent-conflict',
          `the plan is partially present: ${String(stillThere.length)} replaced node(s) `
          + `are back while ${String(stale.size)} of its receipts are in the array; `
          + 'the stale receipts are dropped', cleaned);
      }
      return {
        status: 'staged', messages, receiptTexts: renderedByRecall,
        restores: [...restorations.values()],
      };
    }
  }

  // The revision the plan was approved against. Nothing below this line trusts
  // an index or a byte that this check has not first matched.
  let snapshotIds: readonly string[];
  let revision: string;
  try {
    const derived = deriveOpencodeSnapshot(messages, { sessionId });
    snapshotIds = derived.snapshot.nodes.map(node => node.id);
    revision = derived.snapshot.revision;
  } catch (error) {
    return refuse('unsupported', 'unknown-part-shape', messageOf(error));
  }
  if (!sameIds(currentIds, snapshotIds)) {
    return refuse('unsupported', 'unknown-part-shape',
      'the projection and the snapshot disagree on the node list');
  }
  if (revision !== revert.baseRevision) {
    return refuse('stale-revision', 'stale-revision',
      `the array is at ${revision}, the plan was approved against ${revert.baseRevision}`);
  }
  // An archive names a node this request carries. A foreign node means the
  // application and the array disagree, so no part of it is applied. This runs
  // after the revision match: a stale array is `stale-revision` (a retry, not a
  // defect), while a matching revision with a foreign archive is a bad plan.
  //
  // It also runs after the idempotency block, which is the plan's identity-first
  // rule: a replay of this intent over its own output stages above, before this
  // check is reached, so a foreign archive never overrides an identity run.
  for (const nodeId of partialKeeps.archived) {
    if (!currentIds.includes(nodeId)) {
      return refuse('unsupported', 'partial-keep-unusable',
        `a verdict archive names ${nodeId}, which this array does not hold`);
    }
  }

  const cut = revert.cutIndex;
  if (!Number.isSafeInteger(cut) || cut < 0 || cut > snapshotIds.length) {
    return refuse('host-error', 'node-missing',
      `cut ${String(cut)} is not a node boundary of this array`);
  }
  const survivors = new Set(revert.survivors);
  const tail = snapshotIds.slice(cut);
  if (!sameIds(tail.filter(id => survivors.has(id)), revert.survivors)) {
    return refuse('host-error', 'node-missing',
      'the plan\'s survivors are not the nodes after its cut minus the forgotten ones');
  }
  const forgotten = tail.filter(id => !survivors.has(id));
  if (forgotten.length === 0) {
    return refuse('host-error', 'node-missing', 'the plan names no removable node');
  }
  if (revert.appends.length !== forgotten.length) {
    return refuse('host-error', 'node-missing',
      'a revert carries exactly one receipt per forgotten node');
  }
  let anchor: string | null = cut > 0 ? (snapshotIds[cut - 1] ?? null) : null;
  let forgottenIndex = 0;
  for (const id of tail) {
    if (survivors.has(id)) {
      anchor = id;
      continue;
    }
    const append = revert.appends[forgottenIndex];
    if (append === undefined || append.afterNodeId !== anchor) {
      return refuse('host-error', 'node-missing',
        `receipt ${String(forgottenIndex)} does not anchor at the prefix tail or the survivor before it`);
    }
    forgottenIndex += 1;
  }

  const removedParts = new Map<number, Set<number>>();
  const removePart = (entryIndex: number, partIndex: number): void => {
    const parts = removedParts.get(entryIndex) ?? new Set<number>();
    parts.add(partIndex);
    removedParts.set(entryIndex, parts);
  };
  /**
   * The parts a partial `keeplines` rewrites instead of removing, keyed by the
   * input message they sit in. Only a unit's result part ever lands here; its
   * call part is what keeps the provider pair intact.
   */
  const replacedParts = new Map<number, Map<number, OpencodeToolResultPart>>();
  /** The exact kept-lines text each partial keep renders, by node id. */
  const keptTexts = new Map<NodeId, string>();
  // ISSUE-259: the retention rules read the request's own live results. Every
  // lane — the at-rest rules and the ask — passes through this derivation, so a
  // plan that would take the recall answer or a contained result is refused
  // here even when an earlier eligibility check missed it.
  //
  // The rules gate a **first-time offer** only. The host rebuilds every request
  // from its own store, so a unit a prior pass banked is present again and its
  // removal is re-derived; that is the removal staying in effect, not a new
  // offer, and a live result that now contains its text must not reverse it.
  // The applied-plan index names every unit a prior pass forgot, and
  // `restoreEpochOf` dates the epoch: a unit the array places after a visible
  // restore of its recall is a new instance and the rules apply again.
  const liveResults = opencodeLiveResults(messages, sessionId);
  for (const id of forgotten) {
    const location = locationByNode.get(id);
    if (location === undefined) {
      return refuse('host-error', 'node-missing', `${id} is not in this array`);
    }
    const message = messages[location.entryIndex];
    if (location.kind === 'entry') {
      if (message !== undefined && (isPromptEntry(message) || message.role === 'system')) {
        // A prompt's or the system message's bytes are neither tool output nor
        // the plan's to remove.
        return refuse('unsupported', 'system-head',
          `the plan would remove ${id}, which belongs to a prompt or the system message`);
      }
      return refuse('unsupported', 'tool-pair-split',
        `${id} is not a host part; removing it would drop the rest of its message`);
    }
    if (location.kind === 'declaration') {
      return refuse('unsupported', 'tool-pair-split',
        `${id} is not a host part; removing it would drop the rest of its message`);
    }
    if (location.kind === 'unit' && location.parts.length !== 2) {
      return refuse('unsupported', 'tool-pair-split',
        `${id} names a tool result whose call is not in this array`);
    }
    if (location.kind === 'unit') {
      const recallId = recallByForgotten.get(id) ?? null;
      const epoch = recallId === null
        ? null : restoreEpochOf(recallId, id, restorations, currentIds);
      // A banked removal is re-applied: the rules below guard a first-time
      // offer, and this unit's bytes are already archived under its recall.
      const committed = opencodeIsCommittedRemoval(id, index, epoch);
      /**
       * A closed-episode proof is the one first-time offer that may remove an
       * error result, and it exempts EXACTLY that rule. The miss body IS the
       * closed episode's removable content, and ADR-0049 plans the rule on this
       * host even though the appended negative fact is the part it does not pay
       * for. The proof says the bytes are absent, not that they are the
       * necromancy tool's restore payload or that they are contained in a live
       * result, so `recall-answer-retained` and `contained-in-live-result` still
       * refuse the removal. The set is supplied only for the in-flight prune
       * apply; every other lane (`committed` false, no entry here) keeps all
       * three rules.
       */
      const closedEpisode = closedEpisodeNodes?.has(id) === true;
      const retention = committed ? null : opencodeRetentionOf(id, liveResults);
      if (retention !== null
        && !(closedEpisode && retention.code === 'error-result-retained')) {
        return refuse('unsupported', retention.code,
          retention.code === 'error-result-retained'
            ? `the plan would remove ${id}, a tool result whose envelope is an error or a `
              + 'cancelled-tool failure; a failure is never removed, and a tool called once has '
              + 'no other result to control the removal'
            : retention.code === 'recall-answer-retained'
              ? `the plan would remove ${id}, the necromancy tool's own answer; `
                + 'the product never removes its restore payload'
              : `the plan would remove ${id}, whose exact result text is contained in `
                + `the live result ${String(retention.containedInNodeId)}`);
      }
    }
    const partialKeep = partialKeeps.keeps.get(id);
    if (partialKeep !== undefined) {
      // A partial `keeplines`: the unit's call and result parts both stay, and
      // the result part carries only the kept lines. The archive and receipt
      // still name the dropped lines and the recall id that restores them.
      //
      // The retention rules ran just above, so on the first-offer lane an error
      // result refuses `error-result-retained` before this text check is
      // reached: a failure statement keeps its exact shape, not only its text.
      const receiptRecall = recallByForgotten.get(id) ?? null;
      if (receiptRecall !== null && receiptRecall !== partialKeep.recallId) {
        return refuse('unsupported', 'partial-keep-unusable',
          `the receipt for ${id} names ${receiptRecall}, not the archive's recall `
            + `${partialKeep.recallId}`);
      }
      const resultSite = location.kind === 'unit' && location.parts.length === 2
        ? location.parts[1] : undefined;
      const resultPart = resultSite === undefined
        ? undefined : messages[resultSite.entryIndex]?.content[resultSite.partIndex];
      if (resultSite === undefined || !isToolResultPart(resultPart)) {
        return refuse('unsupported', 'unknown-part-shape',
          `${id} does not name a tool-result part a partial keep could rewrite`);
      }
      const payload = opencodeTextPayload(resultPart);
      if (payload === null) {
        return refuse('unsupported', 'partial-keep-non-text',
          `the plan would keep lines of ${id}, whose result is not text this host can carry; `
            + 'the unit keeps whole');
      }
      // The kept lines come out of the archive, never out of the model's answer:
      // the archive's dropped ranges split the unit's own text, and the kept
      // lines are the complement. A body that is not the result text this part
      // carries means the archive and the live result disagree, so the plan is
      // refused rather than shipping invented bytes.
      const kept = partialKeepText(partialKeep);
      if (kept.status === 'refused') {
        return refuse('unsupported', kept.code, `${id}: ${kept.detail}; the unit keeps whole`);
      }
      if (kept.sourceText !== payload.text) {
        return refuse('unsupported', 'partial-keep-unrepresentable',
          `the archive of ${id} describes other text than its live result, so the kept lines `
            + 'cannot be re-emitted; the unit keeps whole');
      }
      const parts = replacedParts.get(resultSite.entryIndex) ?? new Map<number, OpencodeToolResultPart>();
      parts.set(resultSite.partIndex, withResultText(resultPart,
        { text: kept.text, encoding: payload.encoding }));
      replacedParts.set(resultSite.entryIndex, parts);
      keptTexts.set(id, kept.text);
      continue;
    }
    for (const part of location.parts) removePart(part.entryIndex, part.partIndex);
  }

  const output: OpencodeMessage[] = [];
  /** Where a receipt anchored in one input message lands: before the j-th output message, or after it. */
  const slotOfInputEntry = new Map<number, { readonly index: number; readonly side: 'before' | 'after' }>();
  for (let entryIndex = 0; entryIndex < messages.length; entryIndex += 1) {
    const message = messages[entryIndex];
    if (message === undefined) continue; // unreachable: index < messages.length
    const removed = removedParts.get(entryIndex);
    const replaced = replacedParts.get(entryIndex);
    if (removed === undefined && replaced === undefined) {
      slotOfInputEntry.set(entryIndex, { index: output.length, side: 'after' });
      output.push(message);
      continue;
    }
    const content = message.content.map((part, partIndex) => replaced?.get(partIndex) ?? part);
    const kept = removed === undefined
      ? content
      : content.filter((_part, partIndex) => !removed.has(partIndex));
    if (kept.length === 0) {
      slotOfInputEntry.set(entryIndex, { index: output.length, side: 'before' });
      continue;
    }
    slotOfInputEntry.set(entryIndex, { index: output.length, side: 'after' });
    output.push({ ...message, content: kept });
  }

  /**
   * Where a receipt anchored on this input message lands. An assistant message
   * with tool calls and the `tool` messages that answer them are one
   * provider-shape group: a user receipt inside it makes the host rebuild the
   * call as `Tool result missing` and emit the real result after the receipt,
   * where it is an orphan `tool` message. An anchor on any node of that
   * assistant message therefore lands after the group's last result message.
   */
  const receiptSlotOf = (
    entryIndex: number,
  ): { readonly index: number; readonly side: 'before' | 'after' } | undefined => {
    const message = messages[entryIndex];
    if (message?.role === 'assistant') {
      let lastResult = -1;
      for (const part of contentOf(message)) {
        if (!isToolCallPart(part)) continue;
        const result = results.get(part.id)?.[0];
        if (result !== undefined && result.entryIndex > lastResult) lastResult = result.entryIndex;
      }
      if (lastResult > entryIndex) {
        const slot = slotOfInputEntry.get(lastResult);
        if (slot !== undefined) return slot;
      }
    }
    return slotOfInputEntry.get(entryIndex);
  };

  /**
   * Where a receipt lands, as one boundary index in `output`: `k` means
   * "before output[k]". A slot that lands after output[i] and one that lands
   * before output[i + 1] are the same boundary, and therefore one group.
   */
  const pendingAt = new Map<number, {
    readonly message: OpencodeMessage;
    readonly recallId: string;
    /** The append's plan index: the tie-break when one recall appears twice. */
    readonly order: number;
  }[]>();
  /**
   * One receipt message per append. A line the observed array already carries
   * is the append's receipt: reusing the message keeps one line per recall id
   * across a host rebuild. A line whose bytes this pass must change (an older
   * writer's line with no pass segment) is replaced in its own slot, never
   * appended beside itself.
   */
  const appendMessages: (OpencodeMessage | null)[] = revert.appends.map(() => null);
  const replacedReceipts = new Map<OpencodeMessage, OpencodeMessage>();
  for (const [n, append] of revert.appends.entries()) {
    const forgottenId = forgotten[n];
    const text = receiptTexts[n];
    if (forgottenId === undefined || text === undefined) {
      return refuse('host-error', 'node-missing', 'a receipt names no forgotten node');
    }
    const recallId = recallIdOfReceiptLine(text);
    if (recallId === null) {
      return refuse('host-error', 'node-missing', `receipt ${append.noteId} names no recall id`);
    }
    const arrayReceipt = arrayReceipts[n];
    if (arrayReceipt !== undefined) {
      if (arrayReceipt.text === text) {
        appendMessages[n] = arrayReceipt.message;
      } else {
        // The line exists but does not carry the bytes this pass pins (an older
        // writer's line with no pass segment). Replace its content where it
        // stands, keeping the message's own id: the array still carries exactly
        // one line for the recall, and a node the plan kept is still that node.
        const replacement: OpencodeMessage = {
          ...arrayReceipt.message,
          content: [{ type: 'text', text }],
        };
        replacedReceipts.set(arrayReceipt.message, replacement);
        appendMessages[n] = replacement;
      }
      continue;
    }
    const receipt = receiptEntry(intent.intentId, n, append.noteId, text, forgottenId);
    appendMessages[n] = receipt;
    let boundary = 0;
    if (append.afterNodeId !== null) {
      const location = locationByNode.get(append.afterNodeId);
      const slot = location === undefined ? undefined : receiptSlotOf(location.entryIndex);
      if (slot === undefined) {
        return refuse('host-error', 'node-missing',
          `receipt ${append.noteId} anchors on a node this array does not hold`);
      }
      boundary = slot.side === 'before' ? slot.index : slot.index + 1;
    }
    const group = pendingAt.get(boundary) ?? [];
    group.push({ message: receipt, recallId, order: n });
    pendingAt.set(boundary, group);
  }
  // A replaced line keeps its own slot; every other message stays by reference.
  if (replacedReceipts.size > 0) {
    for (let position = 0; position < output.length; position += 1) {
      const message = output[position];
      if (message === undefined) continue;
      const replacement = replacedReceipts.get(message);
      if (replacement !== undefined) output[position] = replacement;
    }
  }

  /**
   * The messages at each boundary, in wire order: every receipt already sitting
   * there (an earlier pass in this request, or a host rebuild that kept the
   * line) plus this pass's receipts (1g FIX 1).
   *
   * **The key is the receipt's recall id.** It does not change with the event,
   * the line itself carries it, and it makes the group's order independent of
   * which subset the latest plan re-applied. In the 1g run a pass re-applied
   * one of three receipts and its re-rendered line landed at the head of the
   * group, permuting indices 150-152 while every byte was otherwise identical;
   * a later pass that re-applied all three restored the first order. Here a
   * line is placed where its key already sorts: after its own line when the
   * array carries the same recall (the same line re-rendered, first appearance
   * first), else before the first receipt with a greater key, else after the
   * group. An existing receipt is never moved, so the plan's survivor order is
   * unchanged and the prefix up to the group keeps every byte.
   */
  const placements = new Map<number, OpencodeMessage[]>();
  const receiptRecallAt = (index: number): string | null => {
    const message = output[index];
    return message === undefined ? null : receiptRecallIdOfMessage(message);
  };
  for (const boundary of [...pendingAt.keys()].sort((left, right) => left - right)) {
    const group = pendingAt.get(boundary) ?? [];
    group.sort((left, right) => (left.recallId === right.recallId
      ? left.order - right.order
      : left.recallId < right.recallId ? -1 : 1));
    for (const item of group) {
      // The run is the receipts already sitting at this boundary. A pass that
      // inserted at the same anchor put them at the boundary and they only move
      // forward with the messages, so the run starts there; scanning backward
      // would reach a different group anchored on an earlier message.
      let end = boundary;
      while (end < output.length && receiptRecallAt(end) !== null) end += 1;
      let at = boundary;
      if (end > boundary) {
        let exact = -1;
        let greater = -1;
        for (let index = boundary; index < end; index += 1) {
          const other = receiptRecallAt(index);
          if (other === null) continue;
          if (other === item.recallId) exact = index;
          else if (greater < 0 && other > item.recallId) greater = index;
        }
        at = exact >= 0 ? exact + 1 : greater >= 0 ? greater : end;
      }
      const placed = placements.get(at) ?? [];
      placed.push(item.message);
      placements.set(at, placed);
    }
  }

  const derived: OpencodeMessage[] = [];
  for (let position = 0; position <= output.length; position += 1) {
    derived.push(...(placements.get(position) ?? []));
    const message = output[position];
    if (message !== undefined) derived.push(message);
  }

  // Reasoning bookkeeping (ISSUE-256 item 4): every reasoning part the input
  // carried must come back exactly once, in transcript order, as the same host
  // object. A plan never forgets a reasoning part: dropping the thinking chain
  // would ship a request whose reasoning no longer matches the conversation
  // that produced it, so the mismatch refuses `reasoning-loss` by name instead
  // of letting the removal stage.
  const reasoningProblem = reasoningMismatch(reasoningSites(messages), reasoningSites(derived));
  if (reasoningProblem !== null) {
    return refuse('host-error', 'reasoning-loss', reasoningProblem);
  }

  // The result must project back to exactly the claim the plan made: the host
  // messages before the cut untouched, every surviving host node kept, the
  // forgotten nodes gone (a partial keep's unit stays, carrying only its kept
  // lines) and one receipt per append. A declaration stand-in may have vanished
  // with the last call it declared — it never owned a host byte — but a host
  // part or unit may not.
  let derivedLocations: readonly NodeLocation[];
  try {
    derivedLocations = projectEntries(derived, sessionId);
  } catch (error) {
    return refuse('unsupported', 'unknown-part-shape',
      `the derived array does not project: ${messageOf(error)}`);
  }
  const derivedIds = derivedLocations.map(item => item.nodeId);
  const derivedSet = new Set(derivedIds);
  // Every message wholly before the cut's own message is the cache-valid prefix
  // and comes back as the same object. The cut's message may be rebuilt (it holds
  // a removed part), and a rebuilt message keeps its surviving part objects, so
  // no prefix byte changes — only the message wrapper.
  const cutEntryIndex = locationByNode.get(snapshotIds[cut] ?? '')?.entryIndex ?? messages.length;
  let cursor = 0;
  for (let entryIndex = 0; entryIndex < cutEntryIndex; entryIndex += 1) {
    const message = messages[entryIndex];
    if (message === undefined) continue; // unreachable: index < messages.length
    if (removedParts.has(entryIndex) || replacedParts.has(entryIndex)) {
      return refuse('unsupported', 'system-head',
        `the plan would drop or rebuild message ${String(entryIndex)}, which lies in the prefix`);
    }
    if (output[cursor] !== message) {
      return refuse('unsupported', 'unknown-part-shape',
        `message ${String(entryIndex)} of the prefix did not survive by reference`);
    }
    cursor += 1;
  }
  for (const id of forgotten) {
    const keptText = keptTexts.get(id);
    if (keptText === undefined) {
      if (derivedSet.has(id)) {
        return refuse('host-error', 'node-missing', `the derived array still holds ${id}`);
      }
      continue;
    }
    // A partial keep's unit must still be there, and its result part must carry
    // exactly the lines the verdict kept — never the full body.
    const derivedLocation = derivedLocations.find(location => location.nodeId === id);
    const site = derivedLocation?.kind === 'unit' && derivedLocation.parts.length === 2
      ? derivedLocation.parts[1] : undefined;
    const part = site === undefined ? undefined : derived[site.entryIndex]?.content[site.partIndex];
    const payload = isToolResultPart(part) ? opencodeTextPayload(part) : null;
    if (payload === null || payload.text !== keptText) {
      return refuse('host-error', 'node-missing',
        `the derived array does not carry the kept lines of ${id}`);
    }
  }
  /**
   * True when a surviving part node is still the input's own part.
   *
   * A part node id is positional (`…:part:<message key>:<index>`), so removing
   * an earlier part of the same message renumbers every part after it. The part
   * object is the identity the rebuild preserves (it filters the host's own
   * content), so a survivor whose index moved is accepted by that object:
   * exactly one occurrence, in the same message when the host gave it an id.
   */
  const partSurvived = (location: NodeLocation): boolean => {
    const site = location.parts[0];
    if (location.kind !== 'part' || location.parts.length !== 1 || site === undefined) return false;
    const source = messages[site.entryIndex]?.content[site.partIndex];
    if (source === undefined) return false;
    const sourceId = messages[site.entryIndex]?.id;
    let found = 0;
    for (const message of derived) {
      for (const part of contentOf(message)) {
        if (part !== source) continue;
        if (typeof sourceId === 'string' && message.id !== sourceId) return false;
        found += 1;
      }
    }
    return found === 1;
  };
  for (const id of revert.survivors) {
    if (derivedSet.has(id)) continue;
    const location = locationByNode.get(id);
    // A declaration stand-in may vanish with the last call it declared — it
    // never owned a host byte — but a host part may not.
    if (location?.kind === 'declaration') continue;
    if (location !== undefined && partSurvived(location)) continue;
    return refuse('host-error', 'node-missing', `the derived array lost the kept node ${id}`);
  }
  for (const [n, append] of revert.appends.entries()) {
    const message = appendMessages[n];
    if (message === null || derived.filter(item => item === message).length !== 1) {
      return refuse('host-error', 'node-missing',
        `receipt ${append.noteId} does not appear exactly once in the derived array`);
    }
  }
  return {
    status: 'staged', messages: derived, receiptTexts: renderedByRecall,
    restores: [...restorations.values()],
  };
}
