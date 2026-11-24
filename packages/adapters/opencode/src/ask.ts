/**
 * The opencode prune table ask: the same pass mechanism the dsh adapter runs,
 * rendered for this host (ADR-0050; ADR-0053; ADR-0054; ADR-0060).
 *
 * **The pass is core's.** `planPrunePass` runs L1 over the observed array
 * (`stale-exact-reread`, `closed-episode`, `byte-identical-duplicates`), then
 * the superseded-read dedupe over L1's kept units, then numbers every remaining
 * unit above the 512-byte floor as an ask row. The plan's L1 and dedupe removals
 * travel with the batch, so the mount can hand the same document to the engine
 * that dsh's prune pass hands (`planPrunePass` -> `applyPruneAnswers` ->
 * `{kind: 'prune'}`); the opencode lane is no longer a table without a pass.
 *
 * **The prompt is the product's `jsonl-20-nokeepall` message.** It is core's
 * `entryBatchAskMessage(rows, "jsonl-20-nokeepall", firstTrigger)`, the same
 * three-piece bytes the dsh depth table sends (ISSUE-508; ADR-0050 §Amendment
 * 2026-11-23): the pre-table contract, the rendered table with each row's
 * ` [L line(s)]`, then the post-table repeat that closes on the end anchor. The
 * two actions are `forgetall` and `keeplines`; a whole unit is a full-range
 * `keeplines` with summary `None`. A literal `keepall` is the terminal
 * `action-not-in-grammar` refusal that keeps the unit. The 70 percent share line
 * is on the session's first table ask, the 40 percent line on every later one
 * (ADR-0050 decision 5).
 *
 * A partial `keeplines` is not refused here: it reaches the apply path as
 * itself (`OpencodeToolResultPart.result` can carry a re-emitted kept-line
 * result; whole-part removal is this adapter's policy, not a host limit —
 * ADR-0054 §Amendment 2026-11-19, corrected 2026-11-23). A whole-range
 * `keeplines` is normalized by the reader to a clean keep, so the apply path
 * never sees a both-ends shape; the unit is released and re-tabled at a later
 * crossing (ADR-0050 decision 3).
 *
 * Eligibility is the product's, not a subset:
 *   - a unit is tabled only after an already-sent request carried its node
 *     (`seenNodeIds`, ADR-0054 decision 7);
 *   - a unit this session permanently settled is never tabled again (an
 *     answered `forgetall`, or a refused row whose one re-ask was refused
 *     again); a unit answered `keepall` is released and re-tabled at a later
 *     crossing (ADR-0050 decision 3);
 *   - orphan results (no call part) are skipped, because the derivation refuses
 *     exactly them as `tool-pair-split` (ISSUE-269);
 *   - the three retention rules skip a recall answer, an error/cancelled result,
 *     and a result contained in another live result (ISSUE-259).
 *
 * There is no row cap: every eligible unit rides the one table (ADR-0060
 * §Amendment 2026-11-16).
 *
 * **No session history mutation.** This builder reads the caller's array and
 * returns a plan; it writes nothing into the transcript. `port.observe` records
 * the array it saw, so a caller must not treat the projection as free of side
 * effects.
 */

import {
  DEFAULT_CONFIG, EpisodeTracker, UnitTracker, entryBatchAskMessage,
  isRefusedPruneAnchor, planPrunePass, readJsonl20NoKeepallAnswer,
} from '@cremator/core';
import type {
  DedupeClasses, EntryAnswer, EntryBatchRow, Episode, Jsonl20RowRefusalCode, NodeId,
  PruneAnswerRefusalCode, PruneAnswerRow, PruneAskRow, PruneCallFacts, PrunePassPlan,
  ProcessingUnit, SessionSnapshot, ToolResultNode, UnitId, WireAnswer, WireStamp,
} from '@cremator/core';
import {
  opencodeBankedRemovalOf, opencodeLiveResults, opencodeRetentionOf,
} from './apply.js';
import type { OpencodeAppliedPlanIndex } from './apply.js';
import type { OpencodeMessage } from './host.js';
import { opencodeToolNodeId } from './snapshot.js';

/**
 * The one ask grammar this mount offers through its `crematorAskGrammar`
 * option. The id is this adapter's own mount-option name; the PROMPT and the
 * READER are core's `jsonl-20-nokeepall` family (ISSUE-509), so the table and
 * the answer shape are byte-for-byte dsh's. No host config may name another.
 */
export const OPENCODE_ASK_GRAMMAR = 'prune-two-option';

export type OpencodeAskGrammar = typeof OPENCODE_ASK_GRAMMAR;

/**
 * The WIRE grammar this mount's ask actually is: core's `jsonl-20-nokeepall`
 * prompt and reader (ISSUE-508; ISSUE-509). `OPENCODE_ASK_GRAMMAR` above is
 * only the mount-option id a host config names; the journal and the capability
 * line carry this value as `promptGrammar` so a run record names the message
 * that was sent, not an adapter label.
 */
export const OPENCODE_ASK_PROMPT_GRAMMAR = 'jsonl-20-nokeepall';

/** The slice of the mount's port the ask needs: the snapshot projection. */
export interface OpencodeAskPort {
  observe(messages: readonly OpencodeMessage[]): SessionSnapshot;
}

/** The product floor an ask tables: `DEFAULT_CONFIG.protocol.barBytes` (512). */
export const OPENCODE_ASK_FLOOR_BYTES = DEFAULT_CONFIG.protocol.barBytes;

/**
 * The retired adapter frame. It is NOT part of the message this mount sends:
 * ISSUE-509 makes the ask core's own `jsonl-20-nokeepall` bytes, which open on
 * the pre-table contract. No in-repo consumer imports it any more (the bench
 * mock lane keys on the jsonl-20 markers); it stays exported for source
 * compatibility with earlier releases, and a breaking release can remove it.
 */
export const OPENCODE_ASK_FRAME =
  'The messages above are the production conversation. This message is one table of units still '
  + 'in memory: each row begins with the index you answer with, names the call that produced it, '
  + 'and quotes lines of that unit. Treat the contract, the table and the closing line as '
  + 'instruction, not as content to review.';

/** Every reason an observed unit did not become a row on this pass. */
export interface OpencodeAskDropped {
  /** Tool-result nodes below the product floor: no unit is minted for them. */
  readonly subFloor: number;
  /** Units no already-sent request has carried yet; they are not tabled. */
  readonly unseen: number;
  /** Units this session permanently settled (answered remove, or refused twice). */
  readonly asked: number;
  /** A unit whose tool-call part is absent; the apply derivation refuses it. */
  readonly orphan: number;
  /** A result the `necromancy` tool produced (ISSUE-259). */
  readonly recallAnswer: number;
  /** A unit whose exact result text is a proper substring of another live result. */
  readonly contained: number;
  /** A result whose envelope is an error or a cancelled tool (ISSUE-269). */
  readonly errorResult: number;
  /**
   * Units the pass's L1 layer removed before the table was built. They are not
   * drops in the "could not table" sense: they are the pass working, and the
   * mount applies them through the same prune document.
   */
  readonly l1Removed: number;
  /** Units the superseded-read dedupe removed before the table was built. */
  readonly dedupeRemoved: number;
}

/** One pass's plan, its table rows, addresses and exact prompt bytes. */
export interface OpencodeAskBatch {
  /** The snapshot revision the rows describe; the same-revision guard's key. */
  readonly revision: string;
  /** The pass's round ordinal, stamped on every assigned index. */
  readonly round: number;
  /**
   * The full pass: L1, the dedupe and every ask row. The mount merges this
   * plan's answers with `applyPruneAnswers`, exactly as dsh merges its pass.
   */
  readonly plan: PrunePassPlan;
  /** The rows this fire tables: a seen, unsettled, non-retained subset. */
  readonly rows: readonly PruneAskRow[];
  /** The assigned indices, ascending; the answer's only legal keys. */
  readonly indices: readonly number[];
  /** `index -> unitId + round`, ready for the reply reader. */
  readonly stamps: ReadonlyMap<number, WireStamp>;
  /** The unit each row addresses, index-aligned with `rows`. */
  readonly unitIds: readonly UnitId[];
  /** The one user message `session.generate` appends; null when no row is tabled. */
  readonly prompt: string | null;
  /**
   * Plan rows the ledger already banked. They are not in the table; the apply
   * path re-applies each as a whole-unit `forgetall`, so a prior removal stays
   * in effect after a restart without a new question (ISSUE-300 item 6).
   */
  readonly bankedRows: readonly PruneAskRow[];
  /** Why units the observed array carried did not reach this table. */
  readonly dropped: OpencodeAskDropped;
  /** The product floor used to mint units. */
  readonly floorBytes: number;
}

export interface OpencodeAskInput {
  readonly sessionId: string;
  readonly messages: readonly OpencodeMessage[];
  readonly port: OpencodeAskPort;
  /**
   * The node ids an already-sent request has carried: the session's seen set.
   * Absent means no eligibility filter, for a pure table build; the mount and
   * every apply always supply the session's set (ADR-0054).
   */
  readonly seenNodeIds?: ReadonlySet<NodeId>;
  /** Units permanently settled: never tabled again in this session. */
  readonly askedUnitIds?: ReadonlySet<UnitId>;
  /**
   * The pass round stamped on every index. Defaults to 1 for a pure table
   * build; the mount always passes its own monotonic `passRound`.
   */
  readonly round?: number;
  /**
   * Which superseded-read dedupe classes run (ADR-0037). Absent means every
   * class is off, the dsh mount's shipped default: the lane is wired and can
   * be enabled, never silently on.
   */
  readonly classes?: DedupeClasses;
  /**
   * The ledger's applied plans, when the caller has them. A unit one of them
   * already banked (and the array does not place after a restore) is not
   * tabled: its removal is re-applied through the same prune document, never
   * re-asked (ISSUE-300 item 6).
   */
  readonly appliedPlans?: OpencodeAppliedPlanIndex;
  /**
   * Whether this fire is the session's FIRST table ask (ISSUE-194; ADR-0050
   * decision 5). `true` states the 70 percent keep target, `false` the 40
   * percent one for every later ask. Defaults to `true` for a pure table build;
   * the mount passes `askFires === 0`, its durable count of asks that left and
   * were answered or refused with rows.
   */
  readonly firstTrigger?: boolean;
}

/**
 * The one eligibility rule the table and the apply share (ADR-0054): a unit is
 * eligible only when an already-sent request carried its node. A result that
 * first appears in the step being transformed now is not eligible, so the
 * model is never asked about — and never loses — bytes it has not received.
 */
export function isSeenUnit(
  unit: { readonly nodeId: NodeId }, seenNodeIds: ReadonlySet<NodeId>,
): boolean {
  return seenNodeIds.has(unit.nodeId);
}

/** The tool name and target a whole call named, keyed by its result node id. */
function callFactsOf(
  messages: readonly OpencodeMessage[], sessionId: string,
): ReadonlyMap<NodeId, PruneCallFacts> {
  const calls = new Map<string, { readonly name: string; readonly target: string | null }>();
  for (const message of messages) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type === 'tool-call' && typeof part['id'] === 'string') {
        const input = part['input'];
        const target = isRecord(input)
          ? firstString(input, ['filePath', 'path'])
            ?? firstArrayString(input, ['paths', 'filePaths'])
          : null;
        calls.set(part['id'], {
          name: typeof part['name'] === 'string' ? part['name'] : '',
          target,
        });
      }
    }
  }
  const facts = new Map<NodeId, PruneCallFacts>();
  for (const message of messages) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type !== 'tool-result' || typeof part['id'] !== 'string') continue;
      const call = calls.get(part['id']);
      const name = typeof part['name'] === 'string' && part['name'].length > 0
        ? part['name'] : call?.name ?? '';
      const callId = part['id'];
      if (typeof callId !== 'string' || callId.length === 0) continue;
      facts.set(opencodeToolNodeId(sessionId, callId), {
        ...(name.length === 0 ? {} : { toolName: name }),
        ...(call?.target === null || call?.target === undefined ? {} : { targetPath: call.target }),
      });
    }
  }
  return facts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function firstArrayString(
  record: Readonly<Record<string, unknown>>, keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      const found = value.find((entry): entry is string =>
        typeof entry === 'string' && entry.length > 0);
      if (found !== undefined) return found;
    }
  }
  return null;
}

/**
 * Builds one pass over every unit the observed array carries. Returns `null`
 * only when the array holds no unit at all (nothing to ask and nothing to
 * remove); a pass with L1/dedupe removals and no table row is returned with
 * `prompt: null`, so the mount can apply those removals without a model call.
 *
 * The plan is built from the same snapshot the at-rest pass sees, after that
 * pass has committed: units the at-rest rules removed are already absent, and
 * the table describes the array the host is about to send.
 */
export function buildOpencodeAskBatch(input: OpencodeAskInput): OpencodeAskBatch | null {
  if (!Array.isArray(input.messages)) {
    throw new TypeError('cremator: the ask needs the context hook\'s message array');
  }
  const round = input.round ?? 1;
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new RangeError('cremator: the ask pass needs a positive round ordinal');
  }
  const snapshot = input.port.observe(input.messages);
  const plan = buildOpencodePassPlan({
    sessionId: input.sessionId,
    snapshot,
    messages: input.messages,
    round,
    ...(input.classes === undefined ? {} : { classes: input.classes }),
  });
  if (plan === null) return null;
  const nodes: ToolResultNode[] = [];
  for (const node of snapshot.nodes) {
    if (node.kind === 'tool-result') nodes.push(node);
  }
  const floorBytes = OPENCODE_ASK_FLOOR_BYTES;
  const nodeBy = new Map(nodes.map(node => [node.id, node] as const));
  const nodeIds = snapshot.nodes.map(node => node.id);
  const appliedPlans = input.appliedPlans;
  const callIds = new Set<string>();
  for (const message of input.messages) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type === 'tool-call' && typeof part['id'] === 'string'
        && part['id'].length > 0) {
        callIds.add(part['id']);
      }
    }
  }
  const live = opencodeLiveResults(input.messages, input.sessionId);
  const asked = input.askedUnitIds ?? new Set<UnitId>();
  const seen = input.seenNodeIds;
  const dropped = {
    subFloor: 0, unseen: 0, asked: 0, orphan: 0, recallAnswer: 0, contained: 0,
    errorResult: 0, l1Removed: plan.l1.removals.length,
    dedupeRemoved: plan.dedupe.removals.length,
  };
  for (const node of nodes) {
    if (node.bytes.length < floorBytes) dropped.subFloor += 1;
  }
  const rows: PruneAskRow[] = [];
  const bankedRows: PruneAskRow[] = [];
  for (const row of plan.askRows) {
    if (appliedPlans !== undefined
      && opencodeBankedRemovalOf(row.unit.nodeId, appliedPlans, input.messages,
        input.sessionId, nodeIds)) {
      bankedRows.push(row);
      continue;
    }
    if (seen !== undefined && !isSeenUnit(row.unit, seen)) { dropped.unseen += 1; continue; }
    if (asked.has(row.unit.id)) { dropped.asked += 1; continue; }
    const node = nodeBy.get(row.unit.nodeId);
    if (node !== undefined && !callIds.has(node.callId)) { dropped.orphan += 1; continue; }
    const retention = opencodeRetentionOf(row.unit.nodeId, live);
    if (retention !== null) {
      if (retention.code === 'recall-answer-retained') dropped.recallAnswer += 1;
      else if (retention.code === 'error-result-retained') dropped.errorResult += 1;
      else dropped.contained += 1;
      continue;
    }
    rows.push(row);
  }
  const prompt = rows.length === 0 ? null : askPromptOf(rows, input.firstTrigger ?? true);
  return {
    revision: snapshot.revision,
    round,
    plan,
    rows,
    indices: rows.map(row => row.index),
    stamps: plan.stamps,
    unitIds: rows.map(row => row.unit.id),
    prompt,
    bankedRows,
    dropped,
    floorBytes,
  };
}

/**
 * The one pass planner both the table builder and the apply path use: L1, the
 * dedupe and the numbered ask rows over a ready snapshot. `null` when the
 * snapshot holds no unit at all. The plan's L1/dedupe removals are part of the
 * document the mount hands the engine, exactly as dsh's `planPrunePass` result
 * is; the table is only the subset of its rows this fire can honestly ask.
 */
export function buildOpencodePassPlan(input: {
  readonly sessionId: string;
  readonly snapshot: SessionSnapshot;
  readonly messages: readonly OpencodeMessage[];
  readonly round: number;
  readonly classes?: DedupeClasses;
}): PrunePassPlan | null {
  if (!Number.isSafeInteger(input.round) || input.round < 1) {
    throw new RangeError('cremator: the pass needs a positive round ordinal');
  }
  const nodes: ToolResultNode[] = [];
  for (const node of input.snapshot.nodes) {
    if (node.kind !== 'tool-result') continue;
    nodes.push(node);
  }
  const units = new UnitTracker({
    sessionId: input.sessionId, barBytes: OPENCODE_ASK_FLOOR_BYTES,
  }).units(input.snapshot);
  if (units.length === 0) return null;
  const episodes: readonly Episode[] = new EpisodeTracker({
    noNewPathSteps: DEFAULT_CONFIG.thresholds.episodeNoNewPathSteps,
  }).detect({
    sessionId: input.sessionId,
    results: nodes,
    currentStepOrdinal: input.snapshot.currentStepOrdinal,
    completedThroughTurnOrdinal: input.snapshot.completedThroughTurnOrdinal,
  });
  return planPrunePass({
    units,
    nodes,
    episodes,
    transcriptNodes: input.snapshot.nodes,
    callFacts: callFactsOf(input.messages, input.sessionId),
    round: input.round,
    classes: input.classes ?? {},
    // The label names the grammar the prompt actually states (ISSUE-522): the
    // entry `jsonl-20-nokeepall` message below, whose reader refuses a literal
    // `keepall` and normalizes a whole-range `keeplines` to a clean `keepall`.
    // Core gates every non-`3option` spelling as the same two-verdict grammar,
    // so the label and the gate agree.
    grammar: 'jsonl-20-nokeepall',
  });
}

/**
 * The exact user turn this host sends. It is core's `jsonl-20-nokeepall` message
 * byte for byte (ISSUE-508; ADR-0050 §Amendment 2026-11-23): the pre-table
 * contract with its table slot replaced by the rendered rows, then the
 * post-table repeat that closes on `[[entry-ask-end:`. `firstTrigger` selects
 * the 70 percent share line for the session's first table ask and the 40
 * percent one for every later ask; both halves of the message state the same
 * variant.
 */
export function askPromptOf(
  rows: readonly PruneAskRow[], firstTrigger = true,
): string {
  return entryBatchAskMessage(entryRowsOf(rows), OPENCODE_ASK_PROMPT_GRAMMAR, firstTrigger);
}

/**
 * The table rows in the entry message's row shape, so the one core builder
 * renders them: the call and its target ride the row's bracket slot, the pass's
 * own `callOrdinal` fixes `(call #k)` (so a row reads the same ordinal on every
 * harness and after a filtered subset), a refused anchor renders its own note,
 * and the line count is the unit's own `L` (`0` for a zero-line unit, which the
 * shared label writes as `[0 lines]`, exactly as the prune renderer does).
 */
function entryRowsOf(rows: readonly PruneAskRow[]): readonly EntryBatchRow[] {
  return rows.map(row => {
    const anchor = row.anchor;
    const count = lineCountOf(row.unit);
    return {
      index: row.index,
      call: anchor.kind,
      ...(anchor.path === undefined ? {} : { path: anchor.path }),
      callOrdinal: anchor.callOrdinal,
      ...(isRefusedPruneAnchor(anchor)
        ? { anchorLines: [], anchorRefusal: anchor.refusal }
        : { anchorLines: anchor.anchors }),
      lineCount: count ?? 0,
    };
  });
}

/** A unit's own positive line count, or null for a zero-line or unreadable range. */
function lineCountOf(unit: ProcessingUnit | undefined): number | null {
  const range = unit?.span.lineRange;
  if (range === null || range === undefined) return null;
  const count = range.endLineInclusive - range.startLine + 1;
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

/** Why one row produced no verdict, in the bulk table's own refusal vocabulary. */
const OPENCODE_ROW_REFUSAL_CODE: Readonly<Record<Jsonl20RowRefusalCode, PruneAnswerRefusalCode>> = {
  'answer-unreadable': 'answer-unreadable',
  'missing-index': 'missing-index',
  'duplicate-index': 'duplicate-index',
  'action-not-in-grammar': 'action-not-in-grammar',
  'malformed-row': 'malformed-row',
  'mixed-keys': 'malformed-row',
  'both-forgotten-and-summary': 'malformed-row',
  'summary-missing': 'malformed-row',
  'summary-too-long': 'malformed-row',
  'bad-range': 'malformed-row',
  'ranges-unordered': 'malformed-row',
  'spans-outside-result': 'spans-outside-result',
};

/**
 * Reads one reply under this ask's grammar: core's
 * `readJsonl20NoKeepallAnswer`, one object per line, one result per assigned
 * index. A row the reader refuses means KEEP.
 *
 *   - `forgetall` — the row removes; the summary is read here and the guard's
 *     25-word limit is the apply path's own check;
 *   - `keeplines` — a partial keep names the lines that STAY; it is answered
 *     here and passed to the apply path as itself (that path re-emits the kept
 *     lines inside the result part, or refuses a non-text result by name). A
 *     whole-range `keeplines` is normalized by the reader to a clean `keepall`,
 *     so it keeps and re-tables at a later crossing;
 *   - `keepall` — not offered by the prompt, so it is the terminal
 *     `action-not-in-grammar` refusal that keeps the unit and spends no re-ask;
 *   - `forgetlines` and every other shape are refused by the line reader and
 *     keep their row.
 *
 * A zero-line unit (the row showed `[0 lines]`) is read with a sentinel count so
 * a `keeplines` answer on it cannot throw, then refused `spans-outside-result`:
 * no span lies inside `1..0`. The check runs on the ANSWER before any keep-all
 * reading is believed: a literal `keepall` is already refused
 * `action-not-in-grammar`, so an ANSWERED `keepall` on such a row can only be
 * the sentinel's normalization of a whole-range `keeplines`, and it must not
 * keep. That is the one place where the bulk table's code differs from the
 * entry reader's, and it matches dsh's `parseTableReply`.
 */
export function readOpencodeAskAnswer(
  batch: OpencodeAskBatch, text: string,
): readonly PruneAnswerRow[] {
  const counts = new Map<number, number>();
  const zeroLine = new Set<number>();
  for (const row of batch.rows) {
    const count = lineCountOf(row.unit);
    if (count === null) {
      zeroLine.add(row.index);
      counts.set(row.index, 1);
    } else {
      counts.set(row.index, count);
    }
  }
  const reading = readJsonl20NoKeepallAnswer(text, batch.indices, counts);
  return reading.rows.map((row): PruneAnswerRow => {
    const stamp = batch.stamps.get(row.index);
    if (stamp === undefined) {
      throw new RangeError(`No stamp for index ${String(row.index)}.`);
    }
    if (row.status === 'refused') {
      // ISSUE-522 (dsh parity): the reader's own finer code rides as `detail`
      // beside the collapsed `malformed-row`, so a report can tell a
      // `mixed-keys` row from any other malformed row. It never changes which
      // unit is kept: `code` alone decides that.
      return { index: row.index, unitId: stamp.unitId, status: 'refused',
        code: OPENCODE_ROW_REFUSAL_CODE[row.code], message: row.message, wireCode: null,
        detail: row.code };
    }
    if (zeroLine.has(row.index)
      && (row.answer.action === 'keeplines' || row.answer.action === 'keepall')) {
      return { index: row.index, unitId: stamp.unitId, status: 'refused',
        code: 'spans-outside-result',
        message: "The keeplines answer named a line outside that row's own 1..L; the row is "
          + 'kept.',
        wireCode: null, detail: 'spans-outside-result' };
    }
    return { index: row.index, unitId: stamp.unitId, status: 'answered',
      answer: wireAnswerOf(row.answer, stamp) };
  });
}

/**
 * One parsed entry answer back in the wire notation the apply path reads. The
 * stamp is the pass's own: identity and round never come from the answer.
 */
function wireAnswerOf(answer: EntryAnswer, stamp: WireStamp): WireAnswer {
  if (answer.action === 'keepall') {
    return { verdict: { unitId: stamp.unitId, answeredInRound: stamp.answeredInRound,
      action: 'keepall' } };
  }
  if (answer.action === 'forgetall') {
    return { verdict: { unitId: stamp.unitId, answeredInRound: stamp.answeredInRound,
      action: 'forgetall', summary: answer.summary } };
  }
  // `forgetlines` cannot leave the `jsonl-20` reader: its action list does not
  // carry it, so it is refused there. The arm keeps the type total.
  if (answer.action === 'forgetlines') {
    return { verdict: { unitId: stamp.unitId, answeredInRound: stamp.answeredInRound,
      action: 'forgetlines', ranges: answer.ranges }, forgetlinesSummary: answer.summary };
  }
  return { verdict: { unitId: stamp.unitId, answeredInRound: stamp.answeredInRound,
    action: 'keeplines', ranges: answer.ranges }, keeplinesSummary: answer.summary };
}
